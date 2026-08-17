/**
 * assembly.compose — lay the shot clips on the beat grid, drop in the title card,
 * and sync to the prepared audio. CPU-only ffmpeg (no GPU on our compute). Writes
 * a composed intermediate at a deterministic key for encode.final to finish.
 *
 * Degrades gracefully when ffmpeg is unavailable (the durable-pipeline spine still
 * completes with a placeholder intermediate).
 */
import { writeFile } from "node:fs/promises";
import { query, queryOne } from "../../lib/db";
import { getObject, putObject } from "../../lib/storage";
import { ffmpegAvailable, runFfmpeg, workDir, join } from "../../lib/media";
import { setProjectStatus, isTitleTransition, aspectDims } from "../../lib/projects";
import { opAudioKey } from "../../lib/music";
import { log } from "../../lib/logger";
import { titleCardKey } from "./titlecardRender";
import type { StageContext } from "../context";

export function composeKey(projectId: string, renderKind: string): string {
  return `projects/${projectId}/compose/${renderKind}.mp4`;
}

export async function assemblyCompose(ctx: StageContext): Promise<void> {
  await setProjectStatus(ctx.projectId, "assembling");

  const shots = await query<{ idx: number; clip_r2_key: string | null; start_ms: number; end_ms: number }>(
    `SELECT idx, clip_r2_key, start_ms, end_ms FROM shots
       WHERE project_id = $1 AND render_kind = $2 AND status = 'succeeded' AND clip_r2_key IS NOT NULL
       ORDER BY idx`,
    [ctx.projectId, ctx.renderKind],
  );
  if (shots.length === 0) throw new Error("assembly.compose: no succeeded shot clips to assemble.");

  const track = await queryOne<{ r2_key: string }>(
    `SELECT r2_key FROM music_tracks WHERE project_id = $1 LIMIT 1`,
    [ctx.projectId],
  );
  const proj = await queryOne<{ title_transition: string; aspect_ratio: string }>(
    `SELECT title_transition, aspect_ratio FROM projects WHERE id = $1`,
    [ctx.projectId],
  );
  const transition = isTitleTransition(proj?.title_transition) ? proj.title_transition : "cut";
  const { w: OUT_W, h: OUT_H } = aspectDims(proj?.aspect_ratio);

  const outKey = composeKey(ctx.projectId, ctx.renderKind);
  const TITLE_SECONDS = 2; // matches titlecard.render's 2s segment
  const XFADE_SECONDS = 0.8;

  if (!(await ffmpegAvailable())) {
    // No ffmpeg: store a placeholder so the spine completes (e.g. CI without ffmpeg).
    await putObject(outKey, Buffer.from(`STUB-COMPOSE ${ctx.renderKind} ${shots.length} shots`, "utf8"), "application/octet-stream");
    log.warn("assembly.compose: ffmpeg unavailable, wrote placeholder", { projectId: ctx.projectId });
    await ctx.enqueue({ stage: "encode.final" });
    return;
  }

  const { dir, cleanup } = await workDir();
  try {
    // Pull title segment (front) + every shot clip to disk, then NORMALIZE each
    // one: live i2v models return FIXED-length clips (Kling 5s/10s, Veo ~8s) at
    // model resolution, so every segment is trimmed to its exact beat window and
    // re-encoded to uniform 1280x720@24 h264 — that is what makes the cuts land
    // on the beat and makes concat safe across heterogeneous sources.
    let segIdx = 0;

    async function normalize(rawPath: string, durationMs: number | null, fadeIn = false): Promise<string> {
      const out = join(dir, `norm_${String(segIdx++).padStart(3, "0")}.mp4`);
      const trim = durationMs ? ["-t", (durationMs / 1000).toFixed(3)] : [];
      // COVER (fill the frame, center-crop overflow) rather than letterbox — a
      // landscape shot fills a portrait frame instead of showing black bars.
      const vf =
        `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},fps=24` +
        (fadeIn ? `,fade=t=in:st=0:d=${XFADE_SECONDS}` : "");
      await runFfmpeg([
        "-i", rawPath, ...trim, "-vf", vf, "-an",
        // -threads 2 caps libx264's peak memory on constrained workers (each
        // lookahead thread allocates frame buffers — the usual OOM culprit here).
        "-threads", "2", "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p", out,
      ], `normalize seg ${segIdx - 1}`);
      return out;
    }

    // Title segment (with fade-in baked in when requested). Skipped entirely when
    // the user chose 'none' (no title card).
    let titleSeg: string | null = null;
    if (transition !== "none") {
      try {
        const titleBuf = await getObject(titleCardKey(ctx.projectId, "mp4"));
        const tp = join(dir, "raw_title.mp4");
        await writeFile(tp, titleBuf);
        titleSeg = await normalize(tp, null, transition === "fade-in");
      } catch {
        titleSeg = null;
      }
    }

    // Shot segments, each trimmed to its beat window.
    const shotSegs: string[] = [];
    for (const s of shots) {
      const buf = await getObject(s.clip_r2_key!);
      const p = join(dir, `raw_${String(s.idx).padStart(3, "0")}.mp4`);
      await writeFile(p, buf);
      shotSegs.push(await normalize(p, Math.max(250, s.end_ms - s.start_ms)));
    }

    async function concatList(paths: string[], outName: string): Promise<string> {
      const listPath = join(dir, `${outName}.txt`);
      await writeFile(listPath, paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
      const out = join(dir, `${outName}.mp4`);
      await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", out], `concat ${outName}`);
      return out;
    }

    // Combine title + shots per the chosen transition → silent video.
    let concatOut: string;
    if (titleSeg && transition === "fade-over" && shotSegs.length > 0) {
      // Crossfade the title OVER the first part of the body. If the xfade encode
      // fails (e.g. killed on a memory-tight worker), don't fail the whole render
      // — degrade to a hard cut so the user still gets their video.
      try {
        const body = await concatList(shotSegs, "body");
        concatOut = join(dir, "concat.mp4");
        await runFfmpeg([
          "-i", titleSeg, "-i", body,
          "-filter_complex", `[0][1]xfade=transition=fade:duration=${XFADE_SECONDS}:offset=${TITLE_SECONDS - XFADE_SECONDS}`,
          "-threads", "2", "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p", concatOut,
        ], "xfade title-over-body");
      } catch (err) {
        log.warn("assembly.compose: fade-over failed, falling back to hard cut", {
          projectId: ctx.projectId,
          error: err instanceof Error ? err.message : String(err),
        });
        concatOut = await concatList([titleSeg, ...shotSegs], "concat");
      }
    } else {
      // cut / fade-in: hard concat (title fade-in, if any, is baked into titleSeg).
      concatOut = await concatList(titleSeg ? [titleSeg, ...shotSegs] : shotSegs, "concat");
    }

    // Mux the TRIMMED OP audio (the chosen start→stop window, produced by
    // music.prepare) onto the video, cut to the shorter of the two. Fall back to
    // the full track only if the trimmed file is somehow missing.
    const composed = join(dir, "composed.mp4");
    let audioBuf: Buffer | null = null;
    try {
      audioBuf = await getObject(opAudioKey(ctx.projectId));
    } catch {
      audioBuf = track ? await getObject(track.r2_key).catch(() => null) : null;
    }
    if (audioBuf) {
      const audioPath = join(dir, "audio.m4a");
      await writeFile(audioPath, audioBuf);
      await runFfmpeg([
        "-i", concatOut, "-i", audioPath,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-shortest", composed,
      ], "mux audio");
    } else {
      await runFfmpeg(["-i", concatOut, "-c", "copy", composed], "copy (no audio)");
    }

    const { readFile } = await import("node:fs/promises");
    await putObject(outKey, await readFile(composed), "video/mp4");
    log.info("assembly.compose ok", { projectId: ctx.projectId, shots: shotSegs.length, transition });
  } finally {
    await cleanup();
  }

  await ctx.enqueue({ stage: "encode.final" });
}

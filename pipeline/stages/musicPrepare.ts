/**
 * music.prepare — ensure the project has a track AND cut it to the chosen OP
 * window. Default is GENERATED (Suno/Udio); the uploaded path is opt-in with
 * recorded liability and already has a music_tracks row by the time we get here.
 *
 * Real songs aren't authored to end at ~90s, so we:
 *   1. ensure the full track exists + probe its real duration,
 *   2. resolve the trim window (user start/stop, clamped — see lib/music),
 *   3. trim that window to a working OP audio file at opAudioKey() for the rest
 *      of the pipeline (beat.detect + assembly run on the trimmed window).
 * Idempotent.
 *
 * Next: beat.detect.
 */
import { writeFile, readFile } from "node:fs/promises";
import { query, queryOne } from "../../lib/db";
import { generateTrack } from "../../lib/models/music";
import { getObject, putObject } from "../../lib/storage";
import { ffmpegAvailable, probeDurationMs, trimAudio, workDir, join } from "../../lib/media";
import { resolveTrim, opAudioKey } from "../../lib/music";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

interface TrackRow {
  id: string;
  source: string;
  r2_key: string;
  duration_ms: number | null;
  trim_start_ms: number | null;
  trim_end_ms: number | null;
}

export async function musicPrepare(ctx: StageContext): Promise<void> {
  let track = await queryOne<TrackRow>(
    `SELECT id, source, r2_key, duration_ms, trim_start_ms, trim_end_ms
       FROM music_tracks WHERE project_id = $1 LIMIT 1`,
    [ctx.projectId],
  );

  // No uploaded track → silent video of the user-chosen length. (An uploaded
  // track always has its row by the time we get here.)
  if (!track) {
    const project = await queryOne<{ music_source: string | null; silent_length_ms: number | null }>(
      `SELECT music_source, silent_length_ms FROM projects WHERE id = $1`,
      [ctx.projectId],
    );
    if (project?.music_source === "uploaded") {
      throw new Error("music.prepare: music_source=uploaded but no music_tracks row exists.");
    }
    const len = project?.silent_length_ms ?? 30_000;
    const generated = await generateTrack(ctx.projectId, len);
    // trim = the whole silent clip, so resolveTrim uses the full chosen length.
    track = (await queryOne<TrackRow>(
      `INSERT INTO music_tracks (project_id, source, r2_key, duration_ms, trim_start_ms, trim_end_ms)
       VALUES ($1,'generated',$2,$3,0,$3)
       RETURNING id, source, r2_key, duration_ms, trim_start_ms, trim_end_ms`,
      [ctx.projectId, generated.r2Key, generated.durationMs],
    ))!;
    log.info("music.prepare silent track", { projectId: ctx.projectId, durationMs: generated.durationMs });
  }

  const ffmpeg = await ffmpegAvailable();

  // Probe the real full duration if we don't have it (uploaded tracks especially).
  let fullDuration = track.duration_ms;
  const { dir, cleanup } = await workDir();
  try {
    let fullPath: string | null = null;
    if (ffmpeg) {
      fullPath = join(dir, "full");
      await writeFile(fullPath, await getObject(track.r2_key));
      if (!fullDuration) {
        fullDuration = await probeDurationMs(fullPath);
      }
    }

    const window = resolveTrim({
      durationMs: fullDuration,
      trimStartMs: track.trim_start_ms,
      trimEndMs: track.trim_end_ms,
    });

    // Cut the chosen window into the working OP audio for downstream stages.
    if (ffmpeg && fullPath) {
      const opPath = join(dir, "op.m4a");
      await trimAudio(fullPath, opPath, window.startMs, window.endMs);
      await putObject(opAudioKey(ctx.projectId), await readFile(opPath), "audio/mp4");
    }

    // Persist the resolved window + duration. The beat grid (next stage) is built
    // over the trimmed length, so duration there is window.lengthMs.
    await query(
      `UPDATE music_tracks
         SET duration_ms = COALESCE($2, duration_ms),
             trim_start_ms = $3, trim_end_ms = $4
       WHERE id = $1`,
      [track.id, fullDuration, window.startMs, window.endMs],
    );
    log.info("music.prepare windowed", {
      projectId: ctx.projectId,
      source: track.source,
      fullDurationMs: fullDuration,
      window,
    });
  } finally {
    await cleanup();
  }

  await ctx.enqueue({ stage: "beat.detect" });
}

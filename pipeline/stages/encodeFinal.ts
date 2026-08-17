/**
 * encode.final + the CHARGE POINT.
 *
 *   • preview  → low-res, WATERMARKED, FREE. renders(kind='preview',
 *                watermarked=true, charged=false). NO ledger entry, ever.
 *   • final    → full-res, clean. The ONLY place credits are charged. In one
 *                transaction (lib/billing.chargeFinalEncode): verify not charged →
 *                write credit_ledger charge_final → flip renders.charged=true,
 *                watermarked=false. Idempotent: re-running never double-charges.
 *
 * See docs/pipeline.md.
 */
import { writeFile, readFile } from "node:fs/promises";
import { query, queryOne } from "../../lib/db";
import { getObject, putObject } from "../../lib/storage";
import { ffmpegAvailable, runFfmpeg, workDir, join } from "../../lib/media";
import { setProjectStatus } from "../../lib/projects";
import { chargeFinalEncode } from "../../lib/billing";
import { projectFinalTokens } from "../../lib/projects";
import { env } from "../../lib/env";
import { resolveTrim, renderMaxMs } from "../../lib/music";
import { log } from "../../lib/logger";
import { composeKey } from "./assemblyCompose";
import type { StageContext } from "../context";

function finalKey(projectId: string, renderKind: string): string {
  return `projects/${projectId}/renders/${renderKind}.mp4`;
}

export async function encodeFinal(ctx: StageContext): Promise<void> {
  await setProjectStatus(ctx.projectId, "encoding");
  const isFinal = ctx.renderKind === "final";

  const project = await queryOne<{ user_id: string; video_model: string; aspect_ratio: string }>(
    `SELECT user_id, video_model, aspect_ratio FROM projects WHERE id = $1`,
    [ctx.projectId],
  );
  if (!project) throw new Error("encode.final: project not found.");
  // Preview: downscale the LONG side to ~480 (keeps orientation).
  const previewScale = project.aspect_ratio === "landscape" ? "scale=480:-2" : "scale=-2:480";
  const track = await queryOne<{
    duration_ms: number | null; trim_start_ms: number | null; trim_end_ms: number | null;
  }>(
    `SELECT duration_ms, trim_start_ms, trim_end_ms FROM music_tracks WHERE project_id = $1 LIMIT 1`,
    [ctx.projectId],
  );
  // OP length = the effective window (full for finals, first 15s for previews).
  const durationMs = track
    ? resolveTrim(
        { durationMs: track.duration_ms, trimStartMs: track.trim_start_ms, trimEndMs: track.trim_end_ms },
        renderMaxMs(ctx.renderKind),
      ).lengthMs
    : 30_000;

  const composed = composeKey(ctx.projectId, ctx.renderKind);
  const outKey = finalKey(ctx.projectId, ctx.renderKind);

  // Encode the deliverable. Preview = downscaled + watermark; final = full-res clean.
  if (await ffmpegAvailable()) {
    const { dir, cleanup } = await workDir();
    try {
      const inPath = join(dir, "in.mp4");
      await writeFile(inPath, await getObject(composed));
      const outPath = join(dir, "out.mp4");
      if (isFinal) {
        // Final = full-res clean. -threads 2 + a fast preset cap libx264's peak
        // memory (per-thread lookahead frame buffers are the OOM culprit on
        // constrained workers).
        await runFfmpeg([
          "-i", inPath,
          "-threads", "2", "-c:v", "libx264", "-preset", "fast", "-crf", "20",
          "-c:a", "aac", "-movflags", "+faststart", outPath,
        ], "encode final");
      } else {
        await runFfmpeg([
          "-i", inPath,
          "-vf", `${previewScale},drawtext=text='OPmyLife.com':fontcolor=white@0.6:fontsize=32:x=w-tw-20:y=h-th-20`,
          "-c:v", "libx264", "-crf", "30", "-c:a", "aac", "-movflags", "+faststart", outPath,
        ]);
      }
      await putObject(outKey, await readFile(outPath), "video/mp4");
    } finally {
      await cleanup();
    }
  } else {
    // No ffmpeg: copy the placeholder intermediate through as the deliverable.
    await putObject(outKey, await getObject(composed), "application/octet-stream");
  }

  // Ensure exactly one renders row per (project, kind). Created watermarked/free;
  // the final path flips watermarked=false + charged=true inside the charge tx.
  await query(
    `INSERT INTO renders (project_id, kind, r2_key, watermarked, duration_ms, charged)
     VALUES ($1, $2, $3, $4, $5, false)
     ON CONFLICT (project_id, kind) DO NOTHING`,
    [ctx.projectId, ctx.renderKind, isFinal ? null : outKey, !isFinal, durationMs],
  );
  const render = await queryOne<{ id: string; charged: boolean }>(
    `SELECT id, charged FROM renders WHERE project_id = $1 AND kind = $2`,
    [ctx.projectId, ctx.renderKind],
  );

  if (isFinal) {
    // THE charge — transactional, idempotent, once. Priced by projectFinalTokens
    // (1 token = $1), the SAME function that produced the quote the user saw and
    // the submit balance gate, so the charge can never disagree with the quote.
    const result = await chargeFinalEncode({
      userId: project.user_id,
      projectId: ctx.projectId,
      renderId: render!.id,
      finalKey: outKey,
      durationMs,
      cost: await projectFinalTokens(ctx.projectId),
    });
    log.info("encode.final charged", {
      projectId: ctx.projectId,
      charged: result.charged,
      alreadyCharged: result.alreadyCharged,
    });
  } else {
    // Preview: persist the key, keep watermark, NEVER touch the ledger.
    await query(
      `UPDATE renders SET r2_key = $2, watermarked = true, duration_ms = $3 WHERE id = $1`,
      [render!.id, outKey, durationMs],
    );
    log.info("encode.final preview (free, watermarked, no ledger entry)", { projectId: ctx.projectId });
  }

  await ctx.enqueue({ stage: "deliver" });
}

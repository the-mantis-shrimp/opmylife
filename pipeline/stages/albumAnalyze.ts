/**
 * album.analyze — Vision LLM pass over the validated photos. Produces hints
 * (people/scene/mood/palette) used later by stylize + the director. Writes the
 * per-asset annotations to assets.meta.
 *
 * Next: faces.cluster IF biometric consent is granted, else jump straight to
 * characters.stylize (the manual-tagging path already wrote characters rows).
 */
import { query } from "../../lib/db";
import { analyzeAlbum } from "../../lib/models/vision";
import { biometricConsentGranted } from "../../lib/consent";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

interface AssetRow { id: string; r2_key: string; mime: string | null; meta: Record<string, unknown> | null }

export async function albumAnalyze(ctx: StageContext): Promise<void> {
  const photos = await query<AssetRow>(
    `SELECT id, r2_key, mime, meta FROM assets WHERE project_id = $1 AND kind = 'photo' AND validated = true ORDER BY position, created_at`,
    [ctx.projectId],
  );

  const analysis = await analyzeAlbum(photos.map((p) => ({ assetId: p.id, r2Key: p.r2_key, mime: p.mime })));

  // Annotate each asset with its hint (merged into meta).
  for (const p of photos) {
    const hint = analysis.perAsset[p.id];
    await query(
      `UPDATE assets SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [p.id, JSON.stringify({ analysis: hint, albumSummary: analysis.summary, palette: analysis.palette })],
    );
  }
  log.info("album.analyze ok", { projectId: ctx.projectId, photos: photos.length });

  const consented = await biometricConsentGranted(ctx.projectId);
  if (consented) {
    await ctx.enqueue({ stage: "faces.cluster" });
  } else {
    // No consent → manual-tagging path already populated characters. Skip face
    // processing entirely and go straight to stylize. Record a skipped run so the
    // UI shows the gate held.
    await query(
      `INSERT INTO job_runs (project_id, stage, status, finished_at)
       VALUES ($1, 'faces.cluster', 'skipped', now())`,
      [ctx.projectId],
    );
    log.info("faces.cluster skipped (no biometric consent)", { projectId: ctx.projectId });
    await ctx.enqueue({ stage: "characters.stylize" });
  }
}

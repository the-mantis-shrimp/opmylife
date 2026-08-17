/**
 * faces.cluster — CONSENT-GATED. The single most important rule in the pipeline:
 * never run face processing without a granted biometric consent row. We re-check
 * the gate here (defense in depth) even though album.analyze already routed us.
 *
 * Writes one `characters` row per detected person and sets identity_path='cluster'.
 * The no-consent manual path produces identical `characters` rows — downstream
 * cannot tell the two apart.
 */
import { query } from "../../lib/db";
import { clusterFaces } from "../../lib/models/vision";
import { biometricConsentGranted } from "../../lib/consent";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

interface AssetRow { id: string; r2_key: string; mime: string | null }

export async function facesCluster(ctx: StageContext): Promise<void> {
  // Hard gate. If consent is not granted, refuse — never silently process faces.
  if (!(await biometricConsentGranted(ctx.projectId))) {
    throw new Error("faces.cluster invoked without granted biometric consent — refusing.");
  }

  const photos = await query<AssetRow>(
    `SELECT id, r2_key, mime FROM assets WHERE project_id = $1 AND kind = 'photo' AND validated = true ORDER BY position, created_at`,
    [ctx.projectId],
  );

  const clusters = await clusterFaces(photos.map((p) => ({ assetId: p.id, r2Key: p.r2_key, mime: p.mime })));

  // Idempotent: only seed characters if none exist yet for this project.
  const existing = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM characters WHERE project_id = $1`,
    [ctx.projectId],
  );
  if (Number(existing[0]?.n ?? 0) === 0) {
    for (const c of clusters) {
      await query(
        `INSERT INTO characters (project_id, label, source_asset_ids) VALUES ($1,$2,$3)`,
        [ctx.projectId, c.suggestedLabel, c.assetIds],
      );
    }
  }
  await query(`UPDATE projects SET identity_path = 'cluster', updated_at = now() WHERE id = $1`, [ctx.projectId]);
  log.info("faces.cluster ok", { projectId: ctx.projectId, characters: clusters.length });

  await ctx.enqueue({ stage: "characters.stylize" });
}

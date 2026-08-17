/**
 * ingest.validate — first stage. Validate uploaded photos (count/format/size,
 * basic safety), reject unusable files with actionable reasons, then advance.
 */
import { query, queryOne } from "../../lib/db";
import { objectExists } from "../../lib/storage";
import { setProjectStatus } from "../../lib/projects";
import { scanImage, scanEnabled, scanEnforcing, alertOperator } from "../../lib/safety";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB/photo
const MIN_PHOTOS = 1;
const MAX_PHOTOS = 40; // capped to control downstream cost

interface AssetRow {
  id: string;
  r2_key: string;
  mime: string | null;
  bytes: string | null;
}

export async function ingestValidate(ctx: StageContext): Promise<void> {
  const photos = await query<AssetRow>(
    `SELECT id, r2_key, mime, bytes FROM assets WHERE project_id = $1 AND kind = 'photo'`,
    [ctx.projectId],
  );

  if (photos.length < MIN_PHOTOS) {
    throw new Error(`Need at least ${MIN_PHOTOS} photo to build a cast; got ${photos.length}.`);
  }
  if (photos.length > MAX_PHOTOS) {
    throw new Error(`Too many photos (${photos.length}); cap is ${MAX_PHOTOS} to control cost.`);
  }

  const rejected: { id: string; reason: string }[] = [];
  for (const p of photos) {
    if (p.mime && !ALLOWED_MIME.has(p.mime)) {
      rejected.push({ id: p.id, reason: `unsupported type ${p.mime}` });
      continue;
    }
    if (p.bytes && Number(p.bytes) > MAX_BYTES) {
      rejected.push({ id: p.id, reason: `file too large (${p.bytes} bytes, max ${MAX_BYTES})` });
    }
  }
  if (rejected.length) {
    throw new Error(`Rejected ${rejected.length} file(s): ${rejected.map((r) => r.reason).join("; ")}`);
  }

  // Verify each photo's bytes actually landed in storage. The asset row is created
  // when the presigned URL is issued (validated=false), BEFORE the browser PUTs the
  // file — so a failed/aborted upload (or a TTL-expired object) leaves a row whose
  // object doesn't exist. Drop those phantom rows here instead of crashing later at
  // album.analyze's getObject ("The specified key does not exist").
  const missing: string[] = [];
  for (const p of photos) {
    if (!(await objectExists(p.r2_key))) missing.push(p.id);
  }
  if (missing.length) {
    // Remove the phantom rows so the user's photo gallery reflects reality, then
    // refuse the whole run — we don't proceed with a partial album. The user must
    // re-upload the missing photo(s) before generating again.
    await query(`DELETE FROM assets WHERE id = ANY($1::uuid[])`, [missing]);
    log.warn("ingest.validate: photos with no stored object (incomplete uploads)", {
      projectId: ctx.projectId,
      missing: missing.length,
    });
    throw new Error(
      `${missing.length} of ${photos.length} photo upload(s) didn't finish uploading. ` +
        `The incomplete photo(s) have been removed — please re-upload them and generate again.`,
    );
  }

  // ── CSAM scan gate ──────────────────────────────────────────────────────
  // MUST run here — before album.analyze forwards any image to a model API.
  // A flagged photo blocks the whole project, puts it under legal hold (no
  // deletion), records evidence, and alerts the operator. We NEVER enqueue the
  // downstream stages for flagged content. Fail-closed on scanner errors in
  // enforce mode. See lib/safety.
  if (scanEnabled) {
    const { getObject } = await import("../../lib/storage");
    for (const p of photos) {
      let verdict;
      try {
        verdict = await scanImage(await getObject(p.r2_key), p.mime ?? "application/octet-stream");
      } catch (err) {
        if (scanEnforcing) {
          await blockForSafety(ctx.projectId, p.id, "scan_error", 0, false, {
            error: err instanceof Error ? err.message : String(err),
          });
          return; // fail-closed: unscanned content does not proceed
        }
        log.warn("ingest.validate: safety scan errored (monitor mode, continuing)", {
          projectId: ctx.projectId,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (verdict.flagged) {
        if (scanEnforcing) {
          await blockForSafety(ctx.projectId, p.id, verdict.provider, verdict.score ?? null, verdict.knownMatch ?? false, verdict.detail);
          return; // HALT — never reaches album.analyze / any model API
        }
        // monitor mode: record + alert but let the pipeline continue (for tuning).
        await recordFlag(ctx.projectId, p.id, verdict.provider, verdict.score ?? null, verdict.knownMatch ?? false, verdict.detail);
        await alertOperator({ projectId: ctx.projectId, assetId: p.id, mode: "monitor", provider: verdict.provider });
      }
    }
  }

  await query(`UPDATE assets SET validated = true WHERE project_id = $1 AND kind = 'photo'`, [ctx.projectId]);
  await setProjectStatus(ctx.projectId, "analyzing");
  log.info("ingest.validate ok", { projectId: ctx.projectId, photos: photos.length });

  await ctx.enqueue({ stage: "album.analyze" });
}

/** Insert a moderation flag (durable evidence record) and return its id. */
async function recordFlag(
  projectId: string,
  assetId: string,
  provider: string,
  score: number | null,
  knownMatch: boolean,
  detail: unknown,
): Promise<string> {
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM projects WHERE id = $1`, [projectId]);
  const rows = await query<{ id: string }>(
    `INSERT INTO moderation_flags (project_id, asset_id, user_id, provider, score, known_match, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
    [projectId, assetId, owner?.user_id ?? null, provider, score, knownMatch, JSON.stringify(detail ?? null)],
  );
  return rows[0].id;
}

/**
 * Block a project for a safety hit: record the flag, set LEGAL HOLD (exempt from
 * all deletion so evidence is preserved), alert the operator, and fail the project
 * with a NEUTRAL, non-tipping message. Never enqueues downstream stages.
 */
async function blockForSafety(
  projectId: string,
  assetId: string,
  provider: string,
  score: number | null,
  knownMatch: boolean,
  detail: unknown,
): Promise<void> {
  const flagId = await recordFlag(projectId, assetId, provider, score, knownMatch, detail);
  await query(`UPDATE projects SET legal_hold = true WHERE id = $1`, [projectId]);
  await alertOperator({ projectId, assetId, flagId, provider, score, knownMatch, action: "blocked+legal_hold" });
  await setProjectStatus(projectId, "failed", {
    stage: "ingest.validate",
    reason: "This upload couldn't be processed.",
  });
  log.error("ingest.validate: BLOCKED for safety; legal hold set", { projectId, assetId, flagId, provider });
}

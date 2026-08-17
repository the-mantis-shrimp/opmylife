/**
 * cleanup.ttl — SERVER-SIDE auto-deletion. Triggered by the delayed job scheduled
 * in deliver AND by the maintenance sweeper scanning projects.expires_at. Deletes
 * inputs/outputs from R2 (belt-and-braces with the bucket lifecycle rule) and
 * marks the project 'expired'. Backs the privacy promise; never browser-tied.
 *
 * Idempotent: deleting an already-expired project's prefix is a no-op.
 */
import { query, queryOne } from "../../lib/db";
import { deleteProjectPrefix } from "../../lib/storage";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

export async function cleanupTtl(ctx: StageContext): Promise<void> {
  const project = await queryOne<{ status: string; expires_at: string | null; legal_hold: boolean }>(
    `SELECT status, expires_at, legal_hold FROM projects WHERE id = $1`,
    [ctx.projectId],
  );
  if (!project) return; // already gone
  if (project.status === "expired") return; // idempotent
  if (project.legal_hold) {
    // Flagged content is PRESERVED for the reporting/retention window — never
    // TTL-deleted. cleanup.ttl is a no-op here (see lib/safety).
    log.warn("cleanup.ttl skipped: project under legal hold", { projectId: ctx.projectId });
    return;
  }

  const deleted = await deleteProjectPrefix(ctx.projectId);
  await query(`UPDATE projects SET status = 'expired', updated_at = now() WHERE id = $1`, [ctx.projectId]);
  log.info("cleanup.ttl deleted project media", { projectId: ctx.projectId, objectsDeleted: deleted });
}

/**
 * Sweeper pass: find projects whose TTL has elapsed but were not cleaned (e.g. a
 * missed delayed job after a restart) and clean them. Run periodically by the
 * worker's maintenance queue.
 */
export async function sweepExpired(): Promise<string[]> {
  const due = await query<{ id: string }>(
    `SELECT id FROM projects
       WHERE expires_at IS NOT NULL AND expires_at <= now()
         AND status NOT IN ('expired')
         AND legal_hold = false`,
  );
  return due.map((d) => d.id);
}

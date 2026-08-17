/**
 * Abuse / cost controls for generation. Previews are FREE to the user but cost
 * us real model spend, so a signed-in user can't be allowed to spam them. Two
 * guards, enforced in the submit route:
 *
 *   • per-user LIFETIME preview cap — durable counter on users.preview_count
 *   • per-user CONCURRENT renders   — count of the user's in-flight projects
 */
import { query } from "./db";
import { env } from "./env";

/** Project statuses that mean "a render is actively in flight" for this user. */
const ACTIVE_STATUSES = [
  "ingesting", "analyzing", "styling", "storyboarding", "generating", "assembling", "encoding",
];

/**
 * Is the user still under their LIFETIME free-preview cap? READ-ONLY — it does NOT
 * consume the quota. Previews are consumed only when one is successfully DELIVERED
 * (see the deliver stage), so a render that fails or that we retry never counts
 * against the user (CLAUDE.md: never charge for drafts or for our own retries).
 */
export async function checkPreviewQuota(
  userId: string,
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const limit = env.previewLimit;
  const rows = await query<{ preview_count: number }>(
    `SELECT preview_count FROM users WHERE id = $1`,
    [userId],
  );
  const used = rows[0]?.preview_count ?? 0;
  return { allowed: used < limit, remaining: Math.max(0, limit - used), limit };
}

/**
 * Consume one lifetime free preview — called from the deliver stage on a
 * SUCCESSFUL preview render only. Not race-critical: the submit gate already
 * bounds concurrency, and over-counting by the in-flight count is harmless.
 */
export async function consumePreviewQuota(userId: string): Promise<void> {
  await query(`UPDATE users SET preview_count = preview_count + 1 WHERE id = $1`, [userId]);
}

/** How many of this user's projects are currently mid-render. */
export async function activeRenderCount(userId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM projects WHERE user_id = $1 AND status = ANY($2::project_status[])`,
    [userId, ACTIVE_STATUSES],
  );
  return Number(rows[0]?.n ?? 0);
}

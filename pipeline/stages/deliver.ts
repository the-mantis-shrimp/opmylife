/**
 * deliver — expose the finished render and schedule server-side TTL cleanup.
 * Sets projects.status='ready' and projects.expires_at (the sweeper scans this).
 * cleanup.ttl is scheduled here as a DELAYED job — deletion is server-side and
 * outlives the browser session; it is NEVER tied to browser close.
 */
import { query, queryOne } from "../../lib/db";
import { pipelineQueue, jobId } from "../../lib/queue";
import { env } from "../../lib/env";
import { snapshotRender } from "../../lib/history";
import { consumePreviewQuota } from "../../lib/ratelimit";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

export async function deliver(ctx: StageContext): Promise<void> {
  const render = await queryOne<{ r2_key: string | null; watermarked: boolean; charged: boolean; duration_ms: number | null }>(
    `SELECT r2_key, watermarked, charged, duration_ms FROM renders WHERE project_id = $1 AND kind = $2`,
    [ctx.projectId, ctx.renderKind],
  );
  if (!render?.r2_key) throw new Error("deliver: render has no r2_key.");

  // Archive this render to history BEFORE any future re-roll overwrites the live
  // key, so a result the user liked is never lost.
  await snapshotRender({
    projectId: ctx.projectId,
    kind: ctx.renderKind,
    liveRenderKey: render.r2_key,
    watermarked: render.watermarked,
    charged: render.charged,
    durationMs: render.duration_ms,
    runToken: ctx.runToken,
  }).catch((err) => log.warn("deliver: history snapshot failed (non-fatal)", { projectId: ctx.projectId, err: String(err) }));

  const ttlMs = env.renderTtlHours * 3_600_000;
  // Flip to 'ready' only if not already delivered — the `status <> 'ready'` guard
  // makes this idempotent so a deliver retry doesn't consume a second preview.
  const readied = await query<{ user_id: string }>(
    `UPDATE projects SET status = 'ready', expires_at = now() + ($2 || ' milliseconds')::interval, updated_at = now()
     WHERE id = $1 AND status <> 'ready'
     RETURNING user_id`,
    [ctx.projectId, String(ttlMs)],
  );

  // Consume ONE lifetime free preview — only now, on a successful preview
  // delivery, so failed renders and our retries never count against the user
  // (CLAUDE.md: never charge for drafts or for our own retries). A final render's
  // credits are charged separately at encode.final.
  if (ctx.renderKind === "preview" && readied.length > 0) {
    await consumePreviewQuota(readied[0].user_id).catch((err) =>
      log.warn("deliver: preview quota consume failed (non-fatal)", { projectId: ctx.projectId, err: String(err) }),
    );
  }

  // Schedule the TTL cleanup as a delayed job (belt to the sweeper's braces).
  // Stable jobId means re-running deliver won't double-schedule.
  await pipelineQueue().add(
    "cleanup.ttl",
    { projectId: ctx.projectId, stage: "cleanup.ttl", renderKind: ctx.renderKind },
    { jobId: jobId({ projectId: ctx.projectId, stage: "cleanup.ttl", renderKind: ctx.renderKind }), delay: ttlMs },
  );

  log.info("deliver ok", { projectId: ctx.projectId, kind: ctx.renderKind, ttlHours: env.renderTtlHours });
  // Terminal stage for this render — no further enqueue.
}

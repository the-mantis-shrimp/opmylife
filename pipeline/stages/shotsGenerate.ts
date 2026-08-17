/**
 * shots.generate — fan-out + per-shot generation + join barrier.
 *
 *   • dispatcher (no shotIdx): enqueue one job per shot row.
 *   • per-shot (shotIdx set): generate the clip for that shot, with a capped
 *     attempt count (cost control). On the last shot to settle, cross the JOIN
 *     barrier and enqueue titlecard.render.
 *
 * Cost control: cap attempts per shot — after the cap, fail the shot instead of
 * burning budget (see docs/pipeline.md).
 */
import { query, queryOne } from "../../lib/db";
import { generateShot, composeCharacterInScene } from "../../lib/models/gateway";
import {
  setProjectStatus, isOpStyle,
  VIDEO_MODELS, DEFAULT_VIDEO_MODEL, IMAGE_MODELS, DEFAULT_IMAGE_MODEL,
} from "../../lib/projects";
import { env } from "../../lib/env";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

interface ShotRow {
  id: string;
  idx: number;
  character_id: string | null;
  start_ms: number;
  end_ms: number;
  prompt: { shotType?: string; motion?: string; refKey?: string | null; description?: string | null; scene?: string | null } | null;
  status: string;
  attempts: number;
  clip_r2_key: string | null;
}

export async function shotsGenerate(ctx: StageContext): Promise<void> {
  if (ctx.shotIdx === undefined) {
    await dispatchFanOut(ctx);
  } else {
    await generateOneShot(ctx, ctx.shotIdx);
  }
}

async function dispatchFanOut(ctx: StageContext): Promise<void> {
  await setProjectStatus(ctx.projectId, "generating");
  const shots = await query<{ idx: number }>(
    `SELECT idx FROM shots WHERE project_id = $1 AND render_kind = $2 ORDER BY idx`,
    [ctx.projectId, ctx.renderKind],
  );
  if (shots.length === 0) throw new Error("shots.generate: no shots derived from storyboard.");

  for (const s of shots) {
    await ctx.enqueue({ stage: "shots.generate", shotIdx: s.idx });
  }
  log.info("shots.generate fan-out", { projectId: ctx.projectId, shots: shots.length });
}

async function generateOneShot(ctx: StageContext, shotIdx: number): Promise<void> {
  const shot = await queryOne<ShotRow>(
    `SELECT * FROM shots WHERE project_id = $1 AND render_kind = $2 AND idx = $3`,
    [ctx.projectId, ctx.renderKind, shotIdx],
  );
  if (!shot) throw new Error(`shots.generate: shot idx ${shotIdx} not found.`);

  // Idempotent: already done.
  if (shot.status === "succeeded" && shot.clip_r2_key) {
    await maybeJoin(ctx);
    return;
  }

  // Count this attempt up front (cost control lives in the DB, not the queue).
  const updated = await queryOne<{ attempts: number }>(
    `UPDATE shots SET status = 'running', attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
    [shot.id],
  );
  const attempts = updated!.attempts;

  try {
    const char = shot.character_id
      ? await queryOne<{ label: string | null }>(`SELECT label FROM characters WHERE id = $1`, [shot.character_id])
      : null;
    const proj = await queryOne<{ style: string; video_model: string; image_model: string; aspect_ratio: string }>(
      `SELECT style, video_model, image_model, aspect_ratio FROM projects WHERE id = $1`,
      [ctx.projectId],
    );
    const style = isOpStyle(proj?.style) ? proj.style : "original";
    // Cost cap: the selected (possibly premium) video model applies to FINAL
    // renders only. Previews always fall back to the cheap env preview route —
    // never bill Veo/Kling-Pro prices for a watermarked draft.
    const modelEndpoint =
      ctx.renderKind === "final"
        ? VIDEO_MODELS[proj?.video_model ?? DEFAULT_VIDEO_MODEL]?.endpoint ?? null
        : null;

    // animate-me: compose the character into the NEW scene first, then animate
    // THAT (instead of animating the plain portrait). album-to-life has no scene.
    let refKey = shot.prompt?.refKey ?? null;
    const scene = shot.prompt?.scene ?? null;
    if (scene && refKey) {
      refKey = await composeCharacterInScene({
        projectId: ctx.projectId,
        refKey,
        scene,
        label: char?.label ?? "the character",
        style,
        imageEndpoint: IMAGE_MODELS[proj?.image_model ?? DEFAULT_IMAGE_MODEL]?.endpoint ?? env.imageModel,
      });
    }

    const result = await generateShot({
      projectId: ctx.projectId,
      characterId: shot.character_id ?? "scene",
      characterLabel: char?.label ?? "the scene",
      hasCharacter: !!shot.character_id,
      durationMs: shot.end_ms - shot.start_ms,
      shotType: shot.prompt?.shotType ?? "shot",
      motion: shot.prompt?.motion,
      description: scene ?? shot.prompt?.description ?? undefined,
      refKey,
      renderKind: ctx.renderKind,
      style,
      modelEndpoint,
      aspect: proj?.aspect_ratio === "landscape" ? "landscape" : "portrait",
    });
    await query(
      `UPDATE shots SET status = 'succeeded', clip_r2_key = $2, error = NULL WHERE id = $1`,
      [shot.id, result.clipKey],
    );
    log.info("shots.generate ok", { projectId: ctx.projectId, idx: shotIdx, attempts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempts < env.shotMaxAttempts) {
      // Under the cap — record and rethrow so BullMQ retries this shot.
      await query(`UPDATE shots SET status = 'failed', error = $2 WHERE id = $1`, [
        shot.id,
        JSON.stringify({ message, attempts }),
      ]);
      throw err;
    }
    // At the cap — fail the shot for good and let the join proceed without it.
    await query(`UPDATE shots SET status = 'failed', error = $2 WHERE id = $1`, [
      shot.id,
      JSON.stringify({ message, attempts, capped: true }),
    ]);
    log.warn("shots.generate capped-failed", { projectId: ctx.projectId, idx: shotIdx, attempts });
  }

  await maybeJoin(ctx);
}

/**
 * Join barrier: proceed to titlecard.render once every shot has SETTLED
 * (succeeded, or capped-failed). The stable jobId on titlecard makes this safe
 * to call from whichever shot settles last. Requires ≥1 succeeded shot.
 */
async function maybeJoin(ctx: StageContext): Promise<void> {
  const counts = await queryOne<{ total: string; settled: string; ok: string; running: string }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('succeeded','failed'))::int AS settled,
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS ok,
            COUNT(*) FILTER (WHERE status IN ('pending','running'))::int AS running
       FROM shots WHERE project_id = $1 AND render_kind = $2`,
    [ctx.projectId, ctx.renderKind],
  );
  const total = Number(counts?.total ?? 0);
  const settled = Number(counts?.settled ?? 0);
  const ok = Number(counts?.ok ?? 0);

  if (settled < total) return; // not everyone is done yet

  if (ok === 0) {
    await setProjectStatus(ctx.projectId, "failed", { stage: "shots.generate", reason: "all shots failed" });
    throw new Error("shots.generate: all shots failed; cannot assemble.");
  }
  log.info("shots.generate join crossed", { projectId: ctx.projectId, ok, total });
  await ctx.enqueue({ stage: "titlecard.render" });
}

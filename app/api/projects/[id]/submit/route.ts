/**
 * POST /api/projects/:id/submit — kick off the render pipeline. THIN route:
 * validates preconditions, sets status, enqueues ingest.validate, returns fast.
 * All heavy work happens in the worker.
 *
 * Body: { renderKind?: 'preview'|'final', musicSource?: 'generated'|'uploaded' }
 * Default renderKind is 'preview' (free, watermarked). 'final' exercises the
 * charge point against the Phase-1 stub credit balance.
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject, setProjectStatus, projectFinalTokens } from "../../../../../lib/projects";
import { query, queryOne } from "../../../../../lib/db";
import { enqueueStage, newRunToken } from "../../../../../lib/queue";
import { balance } from "../../../../../lib/billing";
import { checkPreviewQuota, activeRenderCount } from "../../../../../lib/ratelimit";
import { env } from "../../../../../lib/env";

export const dynamic = "force-dynamic";

const Schema = z.object({
  renderKind: z.enum(["preview", "final"]).default("preview"),
  musicSource: z.enum(["generated", "uploaded"]).default("generated"),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Invalid submit request");
    const { renderKind } = parsed.data;

    // Preconditions: consent decided, photos present, manual path has characters.
    if (!project.identity_path) return bad("Complete the consent step before submitting.");

    const photoCount = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM assets WHERE project_id = $1 AND kind = 'photo'`,
      [project.id],
    );
    if (Number(photoCount?.n ?? 0) === 0) return bad("Upload at least one photo before submitting.");
    // Music is optional: no uploaded track → the video is silent.

    if (project.identity_path === "manual") {
      const charCount = await queryOne<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM characters WHERE project_id = $1`,
        [project.id],
      );
      if (Number(charCount?.n ?? 0) === 0) {
        return bad("Tag at least one character before submitting (manual path).");
      }
    }

    // Abuse / cost controls (previews are free to the user but cost us real
    // model spend). Applies to both kinds: cap concurrent in-flight renders.
    if ((await activeRenderCount(user.id)) >= env.maxConcurrentRenders) {
      return bad(
        `You already have ${env.maxConcurrentRenders} render${env.maxConcurrentRenders === 1 ? "" : "s"} in progress. Wait for one to finish.`,
        429,
      );
    }

    if (renderKind === "final") {
      // Soft token check (the charge is enforced transactionally at encode.final).
      // Same number the UI quoted: scales with photos, OP length, and the models.
      const cost = await projectFinalTokens(project.id);
      const bal = await balance(user.id);
      if (bal < cost) {
        return bad(`Insufficient tokens: need ${cost}, have ${bal}.`, 402);
      }
    } else {
      // Per-user LIFETIME preview cap — the guard against burning model spend on
      // free previews. READ-ONLY here; the quota is consumed only on successful
      // delivery (deliver stage), so failed renders and re-rolls of a failure
      // don't count. (Generate a final to keep making videos.)
      const q = await checkPreviewQuota(user.id);
      if (!q.allowed) {
        return bad(`You've used all ${q.limit} free previews. Generate a final render to continue.`, 429);
      }
    }

    // Music source is set by the /music route on upload; left null → silent
    // (music.prepare synthesizes a silent track). Nothing to force here.

    // Re-roll: clear the prior storyboard/shots/render for THIS render_kind so
    // this submit produces fresh generations instead of reusing existing clips.
    // Stylized character/photo references are kept (identity + cost); only the
    // shot clips + composed render are regenerated. (Music trim/beat grid stays.)
    // job_runs are cleared too so the progress stepper resets (all checks back to
    // "waiting") instead of showing last run's green checks.
    await query(`DELETE FROM shots WHERE project_id = $1 AND render_kind = $2`, [project.id, renderKind]);
    await query(`DELETE FROM renders WHERE project_id = $1 AND kind = $2`, [project.id, renderKind]);
    await query(`DELETE FROM storyboards WHERE project_id = $1`, [project.id]);
    await query(`DELETE FROM job_runs WHERE project_id = $1`, [project.id]);

    await setProjectStatus(project.id, "ingesting");

    // Fresh run token → unique job ids across the whole run, so a resubmit after
    // a failure re-runs every stage cleanly (no stale-job dedup stalls).
    await enqueueStage({
      projectId: project.id,
      stage: "ingest.validate",
      renderKind,
      runToken: newRunToken(),
      attempt: 1,
    });

    return ok({ submitted: true, renderKind });
  });
}

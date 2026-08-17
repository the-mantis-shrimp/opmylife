/**
 * POST /api/projects/:id/cancel — stop an in-progress generation WITHOUT deleting
 * the project. Drops every queued/scheduled pipeline job, clears the in-flight
 * work for this render kind (shots, storyboard, job_runs) so the progress view
 * resets, and returns the project to 'draft' so the user can adjust + resubmit.
 *
 * A completed render (if any) is kept. An actively-running worker stage can't be
 * force-removed mid-lock; with its rows gone it errors out harmlessly and
 * schedules nothing new (same contract as project delete).
 *
 * Body: { renderKind?: 'preview'|'final' } (default 'preview')
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject, setProjectStatus } from "../../../../../lib/projects";
import { query } from "../../../../../lib/db";
import { removeProjectJobs } from "../../../../../lib/queue";
import { log } from "../../../../../lib/logger";

export const dynamic = "force-dynamic";

const Schema = z.object({ renderKind: z.enum(["preview", "final"]).default("preview") });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Invalid cancel request");
    const { renderKind } = parsed.data;

    // 1. Drop queued/scheduled jobs for this project (active ones self-abort).
    const jobsRemoved = await removeProjectJobs(project.id);
    // 2. Clear in-flight generation state so the progress view resets. Keep any
    //    completed render and the stylized refs / music (cost + identity).
    await query(`DELETE FROM shots WHERE project_id = $1 AND render_kind = $2`, [project.id, renderKind]);
    await query(`DELETE FROM storyboards WHERE project_id = $1`, [project.id]);
    await query(`DELETE FROM job_runs WHERE project_id = $1`, [project.id]);
    // 3. Back to draft — user can reconfigure and Generate again.
    await setProjectStatus(project.id, "draft");

    log.info("generation cancelled", { projectId: project.id, jobsRemoved, renderKind });
    return ok({ cancelled: true, jobsRemoved });
  });
}

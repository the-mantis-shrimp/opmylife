/**
 * /api/projects/:id
 *   GET    — aggregate status the UI polls (stage, per-shot progress, renders, error).
 *   PATCH  — update project settings (`style`, `mode`, `direction`).
 *   DELETE — stop generation, delete all media from R2, delete the project.
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../lib/api";
import { currentUser } from "../../../../lib/auth";
import { getOwnedProject, projectStatus, clearStylizedRefs, OP_STYLES, OP_MODES, TITLE_TRANSITIONS, VIDEO_MODEL_KEYS, IMAGE_MODEL_KEYS } from "../../../../lib/projects";
import { query } from "../../../../lib/db";
import { deleteProjectPrefix } from "../../../../lib/storage";
import { removeProjectJobs } from "../../../../lib/queue";
import { log } from "../../../../lib/logger";
import type { RenderKind } from "../../../../lib/queue";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const url = new URL(req.url);
    const renderKind = (url.searchParams.get("renderKind") as RenderKind) || "preview";
    return ok(await projectStatus(params.id, renderKind));
  });
}

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  style: z.enum(OP_STYLES as [string, ...string[]]).optional(),
  mode: z.enum(OP_MODES as [string, ...string[]]).optional(),
  direction: z.string().max(2000).optional(),
  titleCardText: z.string().max(120).optional(),
  titleTransition: z.enum(TITLE_TRANSITIONS as [string, ...string[]]).optional(),
  videoModel: z.enum(VIDEO_MODEL_KEYS as [string, ...string[]]).optional(),
  imageModel: z.enum(IMAGE_MODEL_KEYS as [string, ...string[]]).optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Invalid project settings.");
    const p = parsed.data;
    if (Object.values(p).every((v) => v === undefined)) {
      return bad("Provide at least one setting to update.");
    }

    await query(
      `UPDATE projects SET
         title = COALESCE($2, title),
         style = COALESCE($3, style),
         mode = COALESCE($4, mode),
         direction = COALESCE($5, direction),
         title_card_text = COALESCE($6, title_card_text),
         title_transition = COALESCE($7, title_transition),
         video_model = COALESCE($8, video_model),
         image_model = COALESCE($9, image_model),
         updated_at = now()
       WHERE id = $1`,
      [
        project.id,
        p.title ?? null,
        p.style ?? null,
        p.mode ?? null,
        p.direction ?? null,
        p.titleCardText ?? null,
        p.titleTransition ?? null,
        p.videoModel ?? null,
        p.imageModel ?? null,
      ],
    );

    // Changing the STYLE, MODE, or IMAGE MODEL invalidates every cached stylized
    // reference — clear them so the next Generate re-stylizes all photos with the
    // new look (characters.stylize is idempotent and would otherwise skip them).
    const styleChanged = p.style !== undefined && p.style !== project.style;
    const modeChanged = p.mode !== undefined && p.mode !== project.mode;
    const imageModelChanged = p.imageModel !== undefined && p.imageModel !== project.image_model;
    if (styleChanged || modeChanged || imageModelChanged) {
      await clearStylizedRefs(project.id);
    }

    return ok({ ...p, restylized: styleChanged || modeChanged || imageModelChanged });
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);
    if (project.legal_hold) {
      // Flagged content is preserved for the reporting/retention window — not
      // user-deletable. Neutral message (don't tip off).
      return bad("This project can't be deleted.", 403);
    }

    // 1. Cease generation — drop every queued/scheduled job for this project.
    const jobsRemoved = await removeProjectJobs(project.id);
    // 2. Delete all media (photos, music, character refs, shot clips, renders).
    const objectsDeleted = await deleteProjectPrefix(project.id);
    // 3. Delete the project — cascades to assets, characters, music_tracks, shots,
    //    renders, job_runs, consents (credit_ledger rows keep their history with
    //    project_id set null).
    await query(`DELETE FROM projects WHERE id = $1`, [project.id]);

    log.info("project deleted", { projectId: project.id, jobsRemoved, objectsDeleted });
    return ok({ deleted: project.id, jobsRemoved, objectsDeleted });
  });
}

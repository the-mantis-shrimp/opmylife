/**
 * GET /api/projects/:id/history — the project's saved render history (newest
 * first), each with a previewable/downloadable URL.
 */
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject } from "../../../../../lib/projects";
import { listHistory } from "../../../../../lib/history";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);
    return ok({ history: await listHistory(project.id) });
  });
}

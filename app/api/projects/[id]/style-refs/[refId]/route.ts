/**
 * DELETE /api/projects/:id/style-refs/:refId — remove one style reference image.
 * Deletes the R2 object and the style_refs row, then invalidates cached stylized
 * references so the next Generate re-stylizes without it.
 */
import { ok, bad, guard } from "../../../../../../lib/api";
import { currentUser } from "../../../../../../lib/auth";
import { getOwnedProject, clearStylizedRefs } from "../../../../../../lib/projects";
import { query, queryOne } from "../../../../../../lib/db";
import { deleteObject } from "../../../../../../lib/storage";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { id: string; refId: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const row = await queryOne<{ id: string; r2_key: string }>(
      `SELECT id, r2_key FROM style_refs WHERE id = $1 AND project_id = $2`,
      [params.refId, project.id],
    );
    if (!row) return bad("Style reference not found", 404);

    await query(`DELETE FROM style_refs WHERE id = $1`, [row.id]);
    await deleteObject(row.r2_key); // best-effort; row is already gone
    await clearStylizedRefs(project.id);

    return ok({ deleted: row.id });
  });
}

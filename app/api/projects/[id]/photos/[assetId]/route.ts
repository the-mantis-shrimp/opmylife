/**
 * DELETE /api/projects/:id/photos/:assetId — remove one uploaded photo.
 * Deletes the R2 object and the assets row. Also strips the id from any manual
 * character's source_asset_ids so no dangling reference remains.
 */
import { ok, bad, guard } from "../../../../../../lib/api";
import { currentUser } from "../../../../../../lib/auth";
import { getOwnedProject } from "../../../../../../lib/projects";
import { query, queryOne } from "../../../../../../lib/db";
import { deleteObject } from "../../../../../../lib/storage";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { id: string; assetId: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);
    if (project.legal_hold) return bad("This photo can't be deleted.", 403); // preserved evidence

    const asset = await queryOne<{ id: string; r2_key: string }>(
      `SELECT id, r2_key FROM assets WHERE id = $1 AND project_id = $2 AND kind = 'photo'`,
      [params.assetId, project.id],
    );
    if (!asset) return bad("Photo not found", 404);

    // Remove any reference to this asset from manual character tags first.
    await query(
      `UPDATE characters SET source_asset_ids = array_remove(source_asset_ids, $1::uuid) WHERE project_id = $2`,
      [asset.id, project.id],
    );
    await query(`DELETE FROM assets WHERE id = $1`, [asset.id]);
    await deleteObject(asset.r2_key); // best-effort; row is already gone

    return ok({ deleted: asset.id });
  });
}

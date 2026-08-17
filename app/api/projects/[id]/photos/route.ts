/**
 * /api/projects/:id/photos — manage the uploaded photo gallery.
 *   GET   — list photos in display order, with a previewable URL each.
 *   PATCH — reorder: body { order: [assetId, ...] } sets each photo's position
 *           to its index in the array. Ignores ids not in the project.
 *
 * Deletion is per-photo: DELETE /api/projects/:id/photos/:assetId.
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject } from "../../../../../lib/projects";
import { query } from "../../../../../lib/db";
import { tx } from "../../../../../lib/db";
import { presignDownload, objectExists } from "../../../../../lib/storage";

export const dynamic = "force-dynamic";

// A presigned upload URL is valid for 10 min; only prune rows older than that so
// we never delete a photo whose browser PUT is still in flight.
const UPLOAD_GRACE_MS = 10 * 60 * 1000;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const rows = await query<{
      id: string;
      r2_key: string;
      mime: string | null;
      bytes: string | null;
      position: number;
      created_at: string;
    }>(
      `SELECT id, r2_key, mime, bytes, position, created_at FROM assets
         WHERE project_id = $1 AND kind = 'photo'
         ORDER BY position, created_at`,
      [project.id],
    );

    // Reconcile against storage: the R2 lifecycle rule (or a cleanup pass) may
    // have deleted an object while its DB row remains — a "ghost" that would show
    // as a broken thumbnail. Drop those rows so the gallery reflects what's
    // actually stored, skipping recent rows that may still be uploading.
    const exists = await Promise.all(rows.map((r) => objectExists(r.r2_key)));
    const ghostIds = rows
      .filter((r, i) => !exists[i] && Date.now() - new Date(r.created_at).getTime() > UPLOAD_GRACE_MS)
      .map((r) => r.id);
    if (ghostIds.length) {
      await query(`DELETE FROM assets WHERE id = ANY($1::uuid[])`, [ghostIds]);
    }

    const live = rows.filter((_, i) => exists[i]);
    const photos = await Promise.all(
      live.map(async (r) => ({
        id: r.id,
        mime: r.mime,
        bytes: r.bytes ? Number(r.bytes) : null,
        position: r.position,
        url: await presignDownload(r.r2_key, 1800),
      })),
    );
    return ok({ photos });
  });
}

const ReorderSchema = z.object({ order: z.array(z.string().uuid()).min(1) });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = ReorderSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Provide order: an array of photo asset ids.");

    // Apply positions in one transaction; only rows belonging to this project's
    // photos are affected (the WHERE scopes it, so stray ids are no-ops).
    await tx(async (client) => {
      let pos = 0;
      for (const assetId of parsed.data.order) {
        await client.query(
          `UPDATE assets SET position = $3 WHERE id = $1 AND project_id = $2 AND kind = 'photo'`,
          [assetId, project.id, pos++],
        );
      }
    });
    return ok({ reordered: parsed.data.order.length });
  });
}

/**
 * /api/projects/:id/characters — manual-tagging fallback (no-consent path).
 *   GET  — list characters + the photos available to tag.
 *   POST — create characters by labelling who's who. Writes the SAME `characters`
 *          rows the cluster path produces; downstream is identical.
 *
 * Body: { characters: [{ label, assetIds: string[] }] }
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject } from "../../../../../lib/projects";
import { query } from "../../../../../lib/db";
import { presignDownload } from "../../../../../lib/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const characters = await query(
      `SELECT id, label, source_asset_ids, ref_r2_key FROM characters WHERE project_id = $1 ORDER BY created_at`,
      [project.id],
    );
    const photoRows = await query<{ id: string; r2_key: string }>(
      `SELECT id, r2_key FROM assets WHERE project_id = $1 AND kind = 'photo' ORDER BY position, created_at`,
      [project.id],
    );
    const photos = await Promise.all(
      photoRows.map(async (p) => ({ id: p.id, url: await presignDownload(p.r2_key, 1800) })),
    );
    return ok({ characters, photos });
  });
}

const Schema = z.object({
  characters: z
    .array(z.object({ label: z.string().min(1).max(60), assetIds: z.array(z.string().uuid()).min(1) }))
    .min(1),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    // Guard: manual tagging only makes sense on the no-consent path.
    if (project.identity_path && project.identity_path !== "manual") {
      return bad("This project uses the face-clustering path; manual tagging does not apply.");
    }

    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Provide at least one character with a label and tagged photos.");

    // Replace any prior manual tags for a clean re-submit.
    await query(`DELETE FROM characters WHERE project_id = $1`, [project.id]);
    for (const c of parsed.data.characters) {
      await query(
        `INSERT INTO characters (project_id, label, source_asset_ids) VALUES ($1, $2, $3)`,
        [project.id, c.label, c.assetIds],
      );
    }
    await query(`UPDATE projects SET identity_path = 'manual', updated_at = now() WHERE id = $1`, [project.id]);

    return ok({ count: parsed.data.characters.length });
  });
}

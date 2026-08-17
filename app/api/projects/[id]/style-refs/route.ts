/**
 * /api/projects/:id/style-refs — up to 3 OPTIONAL style reference images that
 * tell characters.stylize which art style to match ("make it look like THIS").
 *   GET  — list current style refs, each with a previewable URL.
 *   POST — issue presigned URLs for direct browser→R2 uploads (capped at 3 total)
 *          and create the matching style_refs rows.
 *
 * Adding a style ref invalidates cached stylized references (like changing the
 * style preset), so the next Generate re-stylizes with the new reference.
 *
 * Body: { files: [{ filename, contentType, bytes? }] }
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject } from "../../../../../lib/projects";
import { query } from "../../../../../lib/db";
import { buildKey, presignUpload, presignDownload } from "../../../../../lib/storage";
import { clearStylizedRefs } from "../../../../../lib/projects";

export const dynamic = "force-dynamic";

const MAX_STYLE_REFS = 3;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const rows = await query<{ id: string; r2_key: string; mime: string | null; bytes: string | null }>(
      `SELECT id, r2_key, mime, bytes FROM style_refs WHERE project_id = $1 ORDER BY created_at`,
      [project.id],
    );
    const styleRefs = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        mime: r.mime,
        bytes: r.bytes ? Number(r.bytes) : null,
        url: await presignDownload(r.r2_key, 1800),
      })),
    );
    return ok({ styleRefs, max: MAX_STYLE_REFS });
  });
}

const Schema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
        bytes: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(MAX_STYLE_REFS),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Invalid upload request");

    // Enforce the cap against what already exists.
    const existing = await query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM style_refs WHERE project_id = $1`,
      [project.id],
    );
    const have = Number(existing[0]?.n ?? 0);
    if (have + parsed.data.files.length > MAX_STYLE_REFS) {
      return bad(`You can upload at most ${MAX_STYLE_REFS} style references (have ${have}).`);
    }

    const results = [];
    for (const f of parsed.data.files) {
      const ext = f.filename.split(".").pop() || "bin";
      const key = buildKey(project.id, "style-refs", ext);
      const row = await query<{ id: string }>(
        `INSERT INTO style_refs (project_id, r2_key, mime, bytes) VALUES ($1, $2, $3, $4) RETURNING id`,
        [project.id, key, f.contentType, f.bytes ?? null],
      );
      const uploadUrl = await presignUpload(key, f.contentType);
      results.push({ id: row[0].id, key, uploadUrl });
    }

    // New style reference → re-stylize on the next Generate.
    await clearStylizedRefs(project.id);
    return ok({ uploads: results });
  });
}

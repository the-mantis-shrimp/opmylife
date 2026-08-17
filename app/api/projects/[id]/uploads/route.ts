/**
 * POST /api/projects/:id/uploads — issue presigned URLs for direct browser→R2
 * uploads and create the matching `assets` rows (validated=false; ingest.validate
 * sets validated later). The browser PUTs each file straight to storage; the API
 * never touches the bytes.
 *
 * Body: { files: [{ filename, contentType, kind?: 'photo'|'music_upload', bytes? }] }
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject } from "../../../../../lib/projects";
import { query } from "../../../../../lib/db";
import { buildKey, presignUpload } from "../../../../../lib/storage";
import { env } from "../../../../../lib/env";

export const dynamic = "force-dynamic";

const Schema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
        kind: z.enum(["photo", "music_upload"]).default("photo"),
        bytes: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(40),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Invalid upload request");

    // Enforce the per-project photo cap.
    const incomingPhotos = parsed.data.files.filter((f) => f.kind === "photo").length;
    if (incomingPhotos > 0) {
      const have = await query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM assets WHERE project_id = $1 AND kind = 'photo'`,
        [project.id],
      );
      if (Number(have[0]?.n ?? 0) + incomingPhotos > env.maxPhotosPerProject) {
        return bad(`You can upload at most ${env.maxPhotosPerProject} photos (have ${have[0]?.n ?? 0}).`);
      }
    }

    // New photos append after the current last position so upload order is kept.
    const maxRow = await query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM assets WHERE project_id = $1 AND kind = 'photo'`,
      [project.id],
    );
    let position = Number(maxRow[0]?.next ?? 0);

    const results = [];
    for (const f of parsed.data.files) {
      const ext = f.filename.split(".").pop() || "bin";
      const key = buildKey(project.id, f.kind === "photo" ? "photos" : "music", ext);
      const row = await query<{ id: string }>(
        `INSERT INTO assets (project_id, kind, r2_key, mime, bytes, position, validated)
         VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
        [project.id, f.kind, key, f.contentType, f.bytes ?? null, f.kind === "photo" ? position++ : 0],
      );
      const uploadUrl = await presignUpload(key, f.contentType);
      results.push({ assetId: row[0].id, key, uploadUrl, kind: f.kind });
    }
    return ok({ uploads: results });
  });
}

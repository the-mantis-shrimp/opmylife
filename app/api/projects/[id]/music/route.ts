/**
 * /api/projects/:id/music — choose the track and set the OP trim window.
 *   GET   — current music selection (source, full duration, trim window, preview URL).
 *   POST  — set source: 'generated' (default) OR 'uploaded' (needs an uploaded
 *           music asset + accepted liability) with an optional start/stop window.
 *   PATCH — update just the trim window (start/stop) on the existing track.
 *
 * Real songs aren't authored to end at ~90s, so the window is how the user picks
 * which slice becomes the OP. Uploaded music records a versioned music_liability
 * consent (docs/privacy-and-consent.md).
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject } from "../../../../../lib/projects";
import { query, queryOne } from "../../../../../lib/db";
import { presignDownload, objectExists } from "../../../../../lib/storage";
import { recordConsent, latestConsent } from "../../../../../lib/consent";
import { resolveTrim, validateTrim, MIN_OP_MS, DEFAULT_OP_MS } from "../../../../../lib/music";

export const dynamic = "force-dynamic";

// A presigned upload URL is valid for 10 min; only prune rows older than that so
// we never delete an upload whose browser PUT is still in flight.
const UPLOAD_GRACE_MS = 10 * 60 * 1000;
const isGhost = (exists: boolean, createdAt: string) =>
  !exists && Date.now() - new Date(createdAt).getTime() > UPLOAD_GRACE_MS;

interface TrackRow {
  id: string;
  source: string;
  r2_key: string;
  duration_ms: number | null;
  trim_start_ms: number | null;
  trim_end_ms: number | null;
  created_at: string;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    let track = await queryOne<TrackRow>(
      `SELECT id, source, r2_key, duration_ms, trim_start_ms, trim_end_ms, created_at
         FROM music_tracks WHERE project_id = $1 LIMIT 1`,
      [project.id],
    );
    const uploadRows = await query<{ id: string; r2_key: string; created_at: string }>(
      `SELECT id, r2_key, created_at FROM assets WHERE project_id = $1 AND kind = 'music_upload' ORDER BY created_at DESC`,
      [project.id],
    );

    // Reconcile against storage: the R2 lifecycle rule (or a cleanup pass) may
    // have deleted an object while its DB row remains — a "ghost". Drop those so
    // the UI reflects what's actually stored, skipping rows that may still be
    // uploading. If the SELECTED track's audio is gone, clear it and fall back to
    // the silent default so the user isn't stuck on a broken upload.
    let musicSource = project.music_source;
    if (track) {
      const trackLive = await objectExists(track.r2_key);
      if (isGhost(trackLive, track.created_at)) {
        await query(`DELETE FROM music_tracks WHERE id = $1`, [track.id]);
        if (musicSource === "uploaded") {
          await query(`UPDATE projects SET music_source = 'generated', updated_at = now() WHERE id = $1`, [project.id]);
          musicSource = "generated";
        }
        track = null;
      }
    }

    const uploadExists = await Promise.all(uploadRows.map((u) => objectExists(u.r2_key)));
    const ghostUploadIds = uploadRows.filter((u, i) => isGhost(uploadExists[i], u.created_at)).map((u) => u.id);
    if (ghostUploadIds.length) {
      await query(`DELETE FROM assets WHERE id = ANY($1::uuid[])`, [ghostUploadIds]);
    }
    const liveUploads = uploadRows.filter((_, i) => uploadExists[i]);
    const liability = await latestConsent(project.id, "music_liability");

    return ok({
      musicSource,
      track: track
        ? {
            ...track,
            window: resolveTrim({
              durationMs: track.duration_ms,
              trimStartMs: track.trim_start_ms,
              trimEndMs: track.trim_end_ms,
            }),
            previewUrl: await presignDownload(track.r2_key, 1800),
          }
        : null,
      uploads: await Promise.all(
        liveUploads.map(async (u) => ({ id: u.id, url: await presignDownload(u.r2_key, 1800) })),
      ),
      liabilityAccepted: liability?.granted === true,
      silentLengthMs: project.silent_length_ms,
      limits: { minOpMs: MIN_OP_MS, maxOpMs: null, defaultOpMs: DEFAULT_OP_MS }, // max = song length
    });
  });
}

const PostSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("generated"), // = silent video of a chosen length
    silentLengthMs: z.number().int().min(15_000).optional(),
  }),
  z.object({
    source: z.literal("uploaded"),
    assetId: z.string().uuid(),
    liabilityAccepted: z.literal(true),
    durationMs: z.number().int().positive().optional(), // browser-probed full length
    trimStartMs: z.number().int().nonnegative().optional(),
    trimEndMs: z.number().int().positive().optional(),
  }),
]);

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Invalid music request (need source, and for uploaded: assetId + liabilityAccepted).");
    const body = parsed.data;

    if (body.source === "generated") {
      // Silent video of a chosen length. Clear any track so music.prepare
      // regenerates a fresh silent clip at the new length.
      await query(
        `UPDATE projects SET music_source = 'generated',
           silent_length_ms = COALESCE($2, silent_length_ms), updated_at = now()
         WHERE id = $1`,
        [project.id, body.silentLengthMs ?? null],
      );
      await query(`DELETE FROM music_tracks WHERE project_id = $1`, [project.id]);
      return ok({ musicSource: "generated", silentLengthMs: body.silentLengthMs });
    }

    // Uploaded path.
    const asset = await queryOne<{ r2_key: string }>(
      `SELECT r2_key FROM assets WHERE id = $1 AND project_id = $2 AND kind = 'music_upload'`,
      [body.assetId, project.id],
    );
    if (!asset) return bad("Uploaded music asset not found for this project.");

    const start = body.trimStartMs ?? 0;
    const end = body.trimEndMs ?? start + DEFAULT_OP_MS;
    const v = validateTrim(start, end, body.durationMs ?? null);
    if (!v.ok) return bad(v.reason);

    // Record liability acceptance as a versioned, append-only consent row.
    await recordConsent({ projectId: project.id, userId: user.id, kind: "music_liability", granted: true });

    // One track per project (Phase 1): replace any prior selection.
    await query(`DELETE FROM music_tracks WHERE project_id = $1`, [project.id]);
    await query(
      `INSERT INTO music_tracks (project_id, source, r2_key, duration_ms, trim_start_ms, trim_end_ms)
       VALUES ($1, 'uploaded', $2, $3, $4, $5)`,
      [project.id, asset.r2_key, body.durationMs ?? null, start, end],
    );
    await query(`UPDATE projects SET music_source = 'uploaded', updated_at = now() WHERE id = $1`, [project.id]);

    return ok({ musicSource: "uploaded", window: { startMs: start, endMs: end, lengthMs: end - start } });
  });
}

const PatchSchema = z.object({
  trimStartMs: z.number().int().nonnegative(),
  trimEndMs: z.number().int().positive(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("Provide trimStartMs and trimEndMs (ms).");

    const track = await queryOne<{ id: string; duration_ms: number | null }>(
      `SELECT id, duration_ms FROM music_tracks WHERE project_id = $1 LIMIT 1`,
      [project.id],
    );
    if (!track) return bad("No track selected yet.");

    const v = validateTrim(parsed.data.trimStartMs, parsed.data.trimEndMs, track.duration_ms);
    if (!v.ok) return bad(v.reason);

    await query(`UPDATE music_tracks SET trim_start_ms = $2, trim_end_ms = $3 WHERE id = $1`, [
      track.id,
      parsed.data.trimStartMs,
      parsed.data.trimEndMs,
    ]);
    return ok({ window: { startMs: parsed.data.trimStartMs, endMs: parsed.data.trimEndMs } });
  });
}

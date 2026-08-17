/**
 * Render history: archive every completed render to a versioned, immutable R2
 * key so a re-roll (which overwrites the live render key) never destroys a
 * result the user liked. History is view + download only.
 */
import { randomUUID } from "node:crypto";
import { query, queryOne } from "./db";
import { copyObject, presignDownload } from "./storage";
import { log } from "./logger";

/** Nominal output dimensions (previews are 480p; finals are full-res clean). */
function dims(watermarked: boolean): { width: number; height: number; hd: boolean } {
  return watermarked ? { width: 480, height: 270, hd: false } : { width: 1280, height: 720, hd: true };
}

/**
 * Snapshot the current live render into render_history at a versioned key.
 * Idempotent per delivery run via (project, kind, run_token).
 */
export async function snapshotRender(args: {
  projectId: string;
  kind: "preview" | "final";
  liveRenderKey: string;
  watermarked: boolean;
  charged: boolean;
  durationMs: number | null;
  runToken?: string;
}): Promise<string | null> {
  // Dedup: a retried deliver for the same run must not duplicate the entry.
  if (args.runToken) {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM render_history WHERE project_id = $1 AND kind = $2 AND run_token = $3`,
      [args.projectId, args.kind, args.runToken],
    );
    if (existing) return existing.id;
  }

  const historyId = randomUUID();
  const destKey = `projects/${args.projectId}/history/${historyId}/render.mp4`;
  await copyObject(args.liveRenderKey, destKey);

  const d = dims(args.watermarked);
  await query(
    `INSERT INTO render_history
       (id, project_id, kind, r2_key, watermarked, hd, width, height, duration_ms, charged, run_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (project_id, kind, run_token) WHERE run_token IS NOT NULL DO NOTHING`,
    [
      historyId, args.projectId, args.kind, destKey,
      args.watermarked, d.hd, d.width, d.height, args.durationMs, args.charged, args.runToken ?? null,
    ],
  );
  log.info("render snapshotted to history", { projectId: args.projectId, historyId, kind: args.kind });
  return historyId;
}

export interface HistoryEntry {
  id: string;
  kind: string;
  watermarked: boolean;
  hd: boolean;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  charged: boolean;
  createdAt: string;
  url: string | null;
  downloadUrl: string | null;
}

/** List a project's render history, newest first, with previewable URLs. */
export async function listHistory(projectId: string): Promise<HistoryEntry[]> {
  const rows = await query<{
    id: string; kind: string; r2_key: string; watermarked: boolean; hd: boolean;
    width: number | null; height: number | null; duration_ms: number | null; charged: boolean; created_at: string;
  }>(
    `SELECT id, kind, r2_key, watermarked, hd, width, height, duration_ms, charged, created_at
       FROM render_history WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      kind: r.kind,
      watermarked: r.watermarked,
      hd: r.hd,
      width: r.width,
      height: r.height,
      durationMs: r.duration_ms,
      charged: r.charged,
      createdAt: r.created_at,
      url: await presignDownload(r.r2_key, 3600),
      // Forces a save (Content-Disposition: attachment) for the Download button.
      downloadUrl: await presignDownload(r.r2_key, 3600, `opmylife-${r.kind}-${r.id.slice(0, 8)}.mp4`),
    })),
  );
}

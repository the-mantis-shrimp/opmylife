/** Project-level helpers shared by API routes and the worker. */
import { query, queryOne } from "./db";
import { env } from "./env";
import { estimateCost, finalTokenCost } from "./pricing";
import type { StageName, RenderKind } from "./queue";

export type ProjectStatus =
  | "draft" | "ingesting" | "analyzing" | "styling" | "storyboarding"
  | "generating" | "assembling" | "encoding" | "ready" | "failed" | "expired";

// 'reference' = the look is defined ENTIRELY by the user's uploaded style
// reference images (its own category — NOT layered on top of pixar/anime).
export type OpStyle = "original" | "pixar" | "anime" | "fantasy" | "reference";
export const OP_STYLES: OpStyle[] = ["original", "pixar", "anime", "fantasy", "reference"];
export function isOpStyle(v: unknown): v is OpStyle {
  return typeof v === "string" && (OP_STYLES as string[]).includes(v);
}

/**
 * album-to-life: every uploaded photo generates exactly one shot, used once,
 *   in upload order — no clip reuse.
 * animate-me: people are extracted from photos and can appear (and be reused)
 *   across multiple shots — the director plans a beat-driven shot list, guided
 *   by an optional free-text `direction` from the user.
 */
export type OpMode = "album-to-life" | "animate-me";
export const OP_MODES: OpMode[] = ["album-to-life", "animate-me"];
export function isOpMode(v: unknown): v is OpMode {
  return typeof v === "string" && (OP_MODES as string[]).includes(v);
}

/** Title-card transition into the first shot ('none' = no title card at all). */
export type TitleTransition = "none" | "cut" | "fade-in" | "fade-over";
export const TITLE_TRANSITIONS: TitleTransition[] = ["none", "cut", "fade-in", "fade-over"];
export function isTitleTransition(v: unknown): v is TitleTransition {
  return typeof v === "string" && (TITLE_TRANSITIONS as string[]).includes(v);
}

/** Output aspect ratio — two phone-friendly presets. */
export type AspectRatio = "portrait" | "landscape";
export const ASPECT_RATIOS: AspectRatio[] = ["portrait", "landscape"];
export function isAspectRatio(v: unknown): v is AspectRatio {
  return v === "portrait" || v === "landscape";
}
/** Even, 720p-class pixel dimensions per preset (h264-safe). */
export const ASPECT_DIMS: Record<AspectRatio, { w: number; h: number }> = {
  portrait: { w: 720, h: 1280 }, // 9:16 — phone-native (TikTok/Reels/Stories)
  landscape: { w: 1280, h: 720 }, // 16:9 — widescreen
};
export function aspectDims(v: unknown): { w: number; h: number } {
  return ASPECT_DIMS[isAspectRatio(v) ? v : "portrait"];
}

/**
 * Curated i2v model choices (key → fal endpoint + label). DEFAULT_VIDEO_MODEL is
 * the selection new projects get. The worker resolves the endpoint from this map;
 * the UI shows the labels. (Previews are always capped to the cheap env preview
 * route regardless of the selection — see shots.generate.)
 */
export const VIDEO_MODELS: Record<string, { label: string; endpoint: string | null }> = {
  "kling-2.1": { label: "Kling 2.1 Standard (fast, cheap)", endpoint: "fal-ai/kling-video/v2.1/standard/image-to-video" },
  "kling-3-pro": { label: "Kling v3 Pro (high quality)", endpoint: "fal-ai/kling-video/v3/pro/image-to-video" },
  "veo-3.1": { label: "Google Veo 3.1 (premium)", endpoint: "fal-ai/veo3.1/image-to-video" },
};
export const DEFAULT_VIDEO_MODEL = "kling-3-pro";
export const VIDEO_MODEL_KEYS = Object.keys(VIDEO_MODELS);
export function isVideoModelKey(v: unknown): v is string {
  return typeof v === "string" && VIDEO_MODEL_KEYS.includes(v);
}

/**
 * Curated IMAGE (stylization) model choices — photo → stylized character
 * reference. DEFAULT_IMAGE_MODEL is the selection new projects get. Stronger
 * editors do a more complete anime/pixar redraw (plain nano-banana is conservative).
 */
export const IMAGE_MODELS: Record<string, { label: string; endpoint: string | null }> = {
  "nano-banana-pro": { label: "Nano Banana Pro (stronger stylization)", endpoint: "fal-ai/nano-banana-pro/edit" },
  "nano-banana": { label: "Nano Banana (fast, subtle)", endpoint: "fal-ai/nano-banana/edit" },
  "gemini-flash": { label: "Gemini 2.5 Flash Image", endpoint: "fal-ai/gemini-25-flash-image/edit" },
  // Non-Gemini editor: restyles real (adult) photos that Gemini's content checker
  // refuses. Also the automatic fallback when a Gemini model content-flags.
  "flux-kontext": { label: "FLUX.1 Kontext Pro (best for real photos)", endpoint: "fal-ai/flux-pro/kontext" },
};
export const DEFAULT_IMAGE_MODEL = "nano-banana-pro";
// Non-Gemini model the gateway falls back to when a Gemini editor content-flags a
// legitimate (adult) photo. Kept here so it's one edit to retarget.
export const FALLBACK_IMAGE_MODEL = "flux-kontext";
export const IMAGE_MODEL_KEYS = Object.keys(IMAGE_MODELS);
export function isImageModelKey(v: unknown): v is string {
  return typeof v === "string" && IMAGE_MODEL_KEYS.includes(v);
}

export interface ProjectRow {
  id: string;
  user_id: string;
  title: string;
  status: ProjectStatus;
  identity_path: "cluster" | "manual" | null;
  music_source: "generated" | "uploaded" | null;
  style: OpStyle;
  mode: OpMode;
  direction: string | null;
  title_card_text: string | null;
  title_transition: TitleTransition;
  video_model: string;
  image_model: string;
  aspect_ratio: AspectRatio;
  silent_length_ms: number;
  expires_at: string | null;
  error: unknown;
  legal_hold: boolean;
  created_at: string;
  updated_at: string;
}

export async function getProject(projectId: string): Promise<ProjectRow | null> {
  return queryOne<ProjectRow>(`SELECT * FROM projects WHERE id = $1`, [projectId]);
}

/** Get a project scoped to its owner (authorization check for API routes). */
export async function getOwnedProject(projectId: string, userId: string): Promise<ProjectRow | null> {
  return queryOne<ProjectRow>(`SELECT * FROM projects WHERE id = $1 AND user_id = $2`, [projectId, userId]);
}

/**
 * Invalidate every cached stylized reference for a project, so the next Generate
 * re-runs characters.stylize from scratch. Called when the look changes (style /
 * mode / image model / style references).
 */
export async function clearStylizedRefs(projectId: string): Promise<void> {
  await query(`UPDATE assets SET ref_r2_key = NULL, style_meta = NULL WHERE project_id = $1`, [projectId]);
  await query(`UPDATE characters SET ref_r2_key = NULL, style_meta = NULL WHERE project_id = $1`, [projectId]);
}

/** The R2 keys of a project's style reference images, in upload order. */
export async function getStyleRefKeys(projectId: string): Promise<string[]> {
  const rows = await query<{ r2_key: string }>(
    `SELECT r2_key FROM style_refs WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows.map((r) => r.r2_key);
}

export async function setProjectStatus(
  projectId: string,
  status: ProjectStatus,
  error?: unknown,
): Promise<void> {
  await query(
    `UPDATE projects SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
    [projectId, status, error === undefined ? null : JSON.stringify(error)],
  );
}

// ── job_runs: durable per-stage execution log the UI reads ──────────────────
export async function startJobRun(projectId: string, stage: StageName, attempt: number): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO job_runs (project_id, stage, status, attempt, started_at)
     VALUES ($1,$2,'running',$3, now()) RETURNING id`,
    [projectId, stage, attempt],
  );
  return row!.id;
}

export async function finishJobRun(
  id: string,
  status: "succeeded" | "failed" | "skipped",
  error?: unknown,
): Promise<void> {
  await query(
    `UPDATE job_runs SET status = $2, finished_at = now(), error = $3 WHERE id = $1`,
    [id, status, error === undefined ? null : JSON.stringify(error)],
  );
}

interface TrimRow {
  trim_start_ms: number | null;
  trim_end_ms: number | null;
  duration_ms: number | null;
}

/**
 * OP length used for PRICING: the chosen music window, else the track's full
 * length, else the silent-video length, else a 90s default. Shared so the quote
 * and the charge measure the same thing (a silent project has no track row until
 * music.prepare runs — without the silent fallback the quote would drift).
 */
function opLengthMsFor(project: { silent_length_ms?: number | null }, track: TrimRow | null): number {
  if (track?.trim_end_ms != null) return track.trim_end_ms - (track.trim_start_ms ?? 0);
  if (track?.duration_ms != null) return track.duration_ms;
  return project.silent_length_ms ?? 90_000;
}

/** Resolve a project's FINAL-render model endpoints (never the preview route). */
function finalEndpointsFor(project: { image_model: string; video_model: string }) {
  return {
    imageEndpoint:
      IMAGE_MODELS[project.image_model]?.endpoint ?? IMAGE_MODELS[DEFAULT_IMAGE_MODEL].endpoint ?? env.imageModel,
    videoEndpoint:
      VIDEO_MODELS[project.video_model]?.endpoint ?? VIDEO_MODELS[DEFAULT_VIDEO_MODEL].endpoint ?? env.i2vModelFinal,
  };
}

/**
 * Tokens charged for a FINAL render of this project (1 token = $1). THE single
 * source of truth — the UI quote, the submit balance gate, and the encode.final
 * charge all call this, so the user is never charged something they weren't shown.
 */
export async function projectFinalTokens(projectId: string): Promise<number> {
  const project = await getProject(projectId);
  if (!project) return 0;
  const counts = await queryOne<{ photos: number; chars: number }>(
    `SELECT
       (SELECT COUNT(*) FROM assets WHERE project_id = $1 AND kind = 'photo')::int AS photos,
       (SELECT COUNT(*) FROM characters WHERE project_id = $1)::int AS chars`,
    [projectId],
  );
  const track = await queryOne<TrimRow>(
    `SELECT trim_start_ms, trim_end_ms, duration_ms FROM music_tracks WHERE project_id = $1 LIMIT 1`,
    [projectId],
  );
  return finalTokenCost({
    mode: project.mode,
    ...finalEndpointsFor(project),
    photoCount: counts?.photos ?? 0,
    characterCount: counts?.chars ?? 0,
    opLengthMs: opLengthMsFor(project, track),
  });
}

/** Aggregate status for the UI: current stage + per-shot progress + last error. */
export async function projectStatus(projectId: string, renderKind: RenderKind = "preview") {
  const project = await getProject(projectId);
  if (!project) return null;

  const stages = await query(
    `SELECT DISTINCT ON (stage) stage, status, attempt, error, finished_at
       FROM job_runs WHERE project_id = $1
       ORDER BY stage, created_at DESC`,
    [projectId],
  );
  const shotRows = await query<{ idx: number; status: string; attempts: number; error: unknown }>(
    `SELECT idx, status, attempts, error FROM shots WHERE project_id = $1 AND render_kind = $2 ORDER BY idx`,
    [projectId, renderKind],
  );
  const shots = {
    total: shotRows.length,
    done: shotRows.filter((s) => s.status === "succeeded").length,
    running: shotRows.filter((s) => s.status === "running").length,
    failed: shotRows.filter((s) => s.status === "failed").length,
    list: shotRows.map((s) => ({ idx: s.idx, status: s.status, attempts: s.attempts, error: s.error })),
  };
  const renderRows = await query<{
    kind: string; watermarked: boolean; charged: boolean; r2_key: string | null; duration_ms: number | null;
  }>(
    `SELECT kind, watermarked, charged, r2_key, duration_ms FROM renders WHERE project_id = $1`,
    [projectId],
  );
  const { presignDownload } = await import("./storage");
  const dlBase =
    project.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "opmylife";
  const renders = await Promise.all(
    renderRows.map(async (r) => ({
      ...r,
      url: r.r2_key ? await presignDownload(r.r2_key, 3600) : null,
      // Separate URL that forces a save (Content-Disposition: attachment) so the
      // Download button downloads instead of opening the video in a new tab.
      downloadUrl: r.r2_key ? await presignDownload(r.r2_key, 3600, `${dlBase}-${r.kind}.mp4`) : null,
    })),
  );

  // Pre-generation cost estimate for the current config (updates live as the
  // user changes photos / models / music window).
  const counts = await queryOne<{ photos: number; chars: number }>(
    `SELECT
       (SELECT COUNT(*) FROM assets WHERE project_id = $1 AND kind = 'photo')::int AS photos,
       (SELECT COUNT(*) FROM characters WHERE project_id = $1)::int AS chars`,
    [projectId],
  );
  const trackRow = await queryOne<TrimRow>(
    `SELECT trim_start_ms, trim_end_ms, duration_ms FROM music_tracks WHERE project_id = $1 LIMIT 1`,
    [projectId],
  );
  const opLengthMs = opLengthMsFor(project, trackRow);
  const finalEndpoints = finalEndpointsFor(project);
  const imageEndpoint = finalEndpoints.imageEndpoint;
  // Previews are capped to the cheap route (see shots.generate) — reflect that in
  // the estimate so a premium model only raises the FINAL cost, not the preview.
  const videoEndpoint = renderKind === "final" ? finalEndpoints.videoEndpoint : env.i2vModelPreview;
  const estimate = {
    ...estimateCost({
      mode: project.mode,
      renderKind,
      imageEndpoint,
      videoEndpoint,
      photoCount: counts?.photos ?? 0,
      characterCount: counts?.chars ?? 0,
      opLengthMs,
    }),
    // Tokens charged for a FINAL (1 token = $1). Always priced on the FINAL model
    // route, so the quote doesn't change when the preview/final toggle flips.
    finalTokens: finalTokenCost({
      mode: project.mode,
      imageEndpoint: finalEndpoints.imageEndpoint,
      videoEndpoint: finalEndpoints.videoEndpoint,
      photoCount: counts?.photos ?? 0,
      characterCount: counts?.chars ?? 0,
      opLengthMs,
    }),
  };

  // Lifetime free-preview usage for this user, so the UI can show remaining
  // previews and warn when they're out. Consumed only on successful delivery.
  const previewRow = await queryOne<{ preview_count: number }>(
    `SELECT preview_count FROM users WHERE id = $1`,
    [project.user_id],
  );
  const previewUsed = previewRow?.preview_count ?? 0;
  const previewQuota = {
    used: previewUsed,
    remaining: Math.max(0, env.previewLimit - previewUsed),
    limit: env.previewLimit,
  };

  return {
    estimate,
    previewQuota,
    project: {
      id: project.id,
      title: project.title,
      status: project.status,
      identityPath: project.identity_path,
      musicSource: project.music_source,
      style: project.style,
      mode: project.mode,
      direction: project.direction,
      titleCardText: project.title_card_text,
      titleTransition: project.title_transition,
      videoModel: project.video_model,
      imageModel: project.image_model,
      aspectRatio: project.aspect_ratio,
      silentLengthMs: project.silent_length_ms,
      expiresAt: project.expires_at,
      error: project.error,
    },
    stages,
    shots,
    renders,
  };
}

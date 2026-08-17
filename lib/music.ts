/**
 * OP-length / trim-window helpers, shared by the music API and the pipeline.
 *
 * The user picks a START and STOP point; the OP is cut to that window (real
 * songs aren't authored to end at a fixed length). The full window drives the
 * FINAL render; PREVIEWS use only the first `PREVIEW_MAX_MS` of that window to
 * keep drafts cheap. Effective length per render kind = resolveTrim(track,
 * renderMaxMs(kind)).
 */
import { env } from "./env";

export const DEFAULT_OP_MS = 30_000; // window/silent-video length when nothing is set
export const MIN_OP_MS = 15_000; // floor — too short isn't an opening
// No fixed ceiling: the max window is the uploaded song's full length.
export const PREVIEW_MAX_MS = env.opLengthMs; // previews use only the first N (default 15s)

export interface TrimInput {
  durationMs: number | null; // full track duration (may be unknown pre-probe)
  trimStartMs: number | null;
  trimEndMs: number | null;
}

export interface TrimWindow {
  startMs: number;
  endMs: number;
  lengthMs: number;
}

/** The effective length cap for a render kind — previews use only the first N. */
export function renderMaxMs(renderKind: "preview" | "final"): number | undefined {
  return renderKind === "preview" ? PREVIEW_MAX_MS : undefined;
}

/**
 * Resolve the effective OP window from a (possibly partial) track row, clamped to
 * the track duration and to [MIN, MAX]. `maxLengthMs` further caps the length
 * from the start (used to give previews only the first 15s). Pure — no I/O.
 */
export function resolveTrim(track: TrimInput, maxLengthMs?: number): TrimWindow {
  const full = track.durationMs && track.durationMs > 0 ? track.durationMs : DEFAULT_OP_MS;

  let start = Math.max(0, track.trimStartMs ?? 0);
  if (start >= full) start = 0; // start past the end of the track → reset

  let end = track.trimEndMs ?? Math.min(full, start + DEFAULT_OP_MS);
  end = Math.min(end, full);

  // Enforce the minimum length; the maximum is the song itself (end ≤ full).
  let length = end - start;
  if (length < MIN_OP_MS) {
    end = Math.min(full, start + MIN_OP_MS);
    if (end - start < MIN_OP_MS) start = Math.max(0, end - MIN_OP_MS);
    length = end - start;
  }
  // Caller cap (e.g. preview → first 15s).
  if (maxLengthMs && length > maxLengthMs) {
    end = start + maxLengthMs;
    length = maxLengthMs;
  }

  return { startMs: Math.round(start), endMs: Math.round(end), lengthMs: Math.round(length) };
}

/** Deterministic key for the trimmed working OP audio music.prepare produces. */
export function opAudioKey(projectId: string): string {
  return `projects/${projectId}/music/op.m4a`;
}

/** Validate a user-supplied window against a known (or assumed) duration. */
export function validateTrim(
  startMs: number,
  endMs: number,
  durationMs: number | null,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { ok: false, reason: "start/end must be numbers (ms)" };
  if (startMs < 0) return { ok: false, reason: "start must be ≥ 0" };
  if (endMs <= startMs) return { ok: false, reason: "end must be after start" };
  const length = endMs - startMs;
  if (length < MIN_OP_MS) return { ok: false, reason: `window too short (min ${MIN_OP_MS / 1000}s)` };
  if (durationMs && endMs > durationMs + 250) return { ok: false, reason: "end is past the track length" };
  return { ok: true };
}

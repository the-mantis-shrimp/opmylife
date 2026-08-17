/**
 * Music client. Default path is GENERATED (Suno/Udio); the user-uploaded path is
 * opt-in with recorded liability (see docs/privacy-and-consent.md). Also hosts
 * beat detection — the grid everything cuts to.
 *
 * MODELS_MODE=stub synthesizes a ~90s tone bed with ffmpeg and a synthetic beat
 * grid so the pipeline runs offline. Swap `live` for Suno/Udio + a real beat
 * detector (MUSIC_API_KEY) in Phase 2.
 */
import { env } from "../env";
import { buildKey, putObject } from "../storage";
import { ffmpegAvailable, runFfmpeg, workDir, readFile, join } from "../media";
import type { BeatGrid } from "./types";

const SILENT_MS = 30_000; // default length for a music-less (silent) project

/**
 * Music is UPLOAD-ONLY (real generation isn't wired). When a project has no
 * uploaded track we produce SILENCE so it still renders — a silent video. The
 * duration is a sensible default; the render length comes from the beat grid.
 */
export async function generateTrack(
  projectId: string,
  durationMs: number = SILENT_MS,
): Promise<{ r2Key: string; durationMs: number }> {
  const r2Key = buildKey(projectId, "music", "m4a");
  const seconds = Math.max(1, durationMs) / 1000;
  if (await ffmpegAvailable()) {
    const { dir, cleanup } = await workDir();
    try {
      const out = join(dir, "track.m4a");
      await runFfmpeg([
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", String(seconds), "-c:a", "aac", out,
      ]);
      await putObject(r2Key, await readFile(out), "audio/mp4");
    } finally {
      await cleanup();
    }
  } else {
    await putObject(r2Key, Buffer.from("STUB-SILENT-AUDIO", "utf8"), "application/octet-stream");
  }
  return { r2Key, durationMs };
}

/**
 * Normalize/trim + detect beats. Produces the beat grid (BPM, beat onsets,
 * section markers) the director and assembly cut against.
 */
export async function detectBeats(durationMs: number): Promise<BeatGrid> {
  if (env.musicMode === "live") {
    throw new Error("music.detectBeats: live mode not yet wired (set MODELS_MODE=stub).");
  }
  // Stub: a steady 120 BPM grid (one beat every 500ms) with three sections.
  const bpm = 120;
  const beatMs = 60_000 / bpm;
  const beats: number[] = [];
  for (let t = 0; t < durationMs; t += beatMs) beats.push(Math.round(t));
  return {
    bpm,
    durationMs,
    beats,
    sections: [
      { label: "intro", startMs: 0 },
      { label: "verse", startMs: Math.round(durationMs * 0.15) },
      { label: "drop", startMs: Math.round(durationMs * 0.55) },
    ],
  };
}

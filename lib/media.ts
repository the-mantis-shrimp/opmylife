/**
 * Thin ffmpeg wrapper for the worker. All heavy media work is CPU-only ffmpeg
 * (no GPU on our compute — generation is offloaded to model APIs). Used by the
 * stub model gateway (to synthesize placeholder clips/audio) and by
 * assembly.compose / encode.final.
 *
 * ffmpeg is a system dependency (installed in the Docker image). If it is not on
 * PATH we degrade gracefully so the durable-pipeline spine still runs.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let _available: boolean | null = null;

export async function ffmpegAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  _available = await new Promise<boolean>((resolve) => {
    const p = spawn("ffmpeg", ["-version"]);
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  return _available;
}

export async function runFfmpeg(args: string[], label?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const where = label ? ` [${label}]` : "";
      // code === null means the process was terminated by a SIGNAL rather than
      // exiting normally. SIGKILL with empty stderr is the classic out-of-memory
      // kill on a constrained container — call that out so it's actionable.
      if (code === null) {
        const oom = signal === "SIGKILL" ? " (likely out of memory — raise the worker's memory limit)" : "";
        return reject(new Error(`ffmpeg killed by ${signal ?? "signal"}${where}${oom}: ${stderr || "(no output)"}`));
      }
      return reject(new Error(`ffmpeg exited ${code}${where}: ${stderr || "(no output)"}`));
    });
  });
}

/**
 * Probe a media file's duration in ms via ffprobe (ships with ffmpeg). Returns
 * null if ffprobe is unavailable or the file can't be read.
 */
export async function probeDurationMs(path: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const seconds = Number.parseFloat(out.trim());
      resolve(Number.isFinite(seconds) ? Math.round(seconds * 1000) : null);
    });
  });
}

/** Probe a video's pixel dimensions via ffprobe. Returns null if unavailable. */
export async function probeDimensions(path: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      path,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const [w, h] = out.trim().split("x").map((n) => Number.parseInt(n, 10));
      resolve(Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null);
    });
  });
}

/** Extract [startMs, endMs] from `input` into `output` (re-encoded AAC). */
export async function trimAudio(input: string, output: string, startMs: number, endMs: number): Promise<void> {
  const ss = (startMs / 1000).toFixed(3);
  const to = (endMs / 1000).toFixed(3);
  await runFfmpeg(["-ss", ss, "-to", to, "-i", input, "-c:a", "aac", output]);
}

/** Create a unique temp working dir; caller must `cleanup()`. */
export async function workDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "anime-op-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export { readFile, join };

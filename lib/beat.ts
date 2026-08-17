/**
 * Real beat detection. Runs entirely on CPU (ffmpeg decode + DSP in JS) — NO
 * external music API needed. Given the trimmed OP audio, it estimates tempo and
 * the beat grid the whole render cuts to:
 *
 *   1. ffmpeg decodes the audio to mono 22.05 kHz PCM.
 *   2. Per-frame energy → positive energy flux = an onset-strength envelope.
 *   3. Autocorrelation of that envelope → dominant period → BPM (octave-corrected).
 *   4. Phase search aligns the beat pulse train to the onsets.
 *   5. Light energy-based section detection (intro / build / drop) for title timing.
 *
 * Falls back to a synthetic 120 BPM grid if ffmpeg is unavailable or the audio is
 * silent/too short.
 */
import { writeFile } from "node:fs/promises";
import { ffmpegAvailable, runFfmpeg, workDir, readFile, join } from "./media";
import type { BeatGrid } from "./models/types";

const SR = 22050; // decode sample rate
const HOP = 256; // frame hop → ~86 fps envelope (fine enough to avoid octave artifacts)
const FPS = SR / HOP;
const MIN_BPM = 70;
const MAX_BPM = 180;

/** Synthetic fallback grid (steady 120 BPM) — used when real analysis can't run. */
export function syntheticGrid(durationMs: number): BeatGrid {
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

/** Detect the real beat grid from encoded audio bytes (the trimmed OP window). */
export async function detectBeatsFromAudio(audio: Buffer, durationMs: number): Promise<BeatGrid> {
  if (!(await ffmpegAvailable())) return syntheticGrid(durationMs);

  const { dir, cleanup } = await workDir();
  try {
    const inPath = join(dir, "in");
    const rawPath = join(dir, "audio.raw");
    await writeFile(inPath, audio);
    // Decode → mono, 22.05kHz, signed 16-bit little-endian raw PCM.
    await runFfmpeg(["-i", inPath, "-ac", "1", "-ar", String(SR), "-f", "s16le", rawPath]);
    const raw = await readFile(rawPath);

    const grid = analyze(raw, durationMs);
    return grid ?? syntheticGrid(durationMs);
  } catch {
    return syntheticGrid(durationMs);
  } finally {
    await cleanup();
  }
}

/** Analyze raw mono s16le 22.05kHz PCM into a beat grid (exported for testing/reuse). */
export function analyze(pcm: Buffer, durationMs: number): BeatGrid | null {
  const n = Math.floor(pcm.length / 2);
  if (n < SR) return null; // < 1s of audio

  // Per-frame RMS energy.
  const frames = Math.floor(n / HOP);
  if (frames < 8) return null;
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * HOP;
    for (let i = 0; i < HOP; i++) {
      const s = pcm.readInt16LE((base + i) * 2) / 32768;
      sum += s * s;
    }
    energy[f] = Math.sqrt(sum / HOP);
  }

  // Onset envelope = positive energy flux (half-wave rectified difference).
  const onset = new Float64Array(frames);
  let onsetMax = 0;
  for (let f = 1; f < frames; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
    if (onset[f] > onsetMax) onsetMax = onset[f];
  }
  if (onsetMax < 1e-6) return null; // silence
  for (let f = 0; f < frames; f++) onset[f] /= onsetMax;

  // Autocorrelation over the lag range implied by [MIN_BPM, MAX_BPM]. Normalize
  // each lag by its overlap count (longer lags have fewer terms) and weight by a
  // log-tempo Gaussian centered near 120 BPM — this suppresses the half/double
  // tempo (octave) errors that a raw autocorrelation is prone to.
  const minLag = Math.max(2, Math.floor((FPS * 60) / MAX_BPM));
  const maxLag = Math.min(frames - 2, Math.ceil((FPS * 60) / MIN_BPM));
  const scores = new Float64Array(maxLag + 1);
  let bestLag = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += onset[f] * onset[f - lag];
    // Raw autocorrelation (naturally favors the true, shorter-lag period over its
    // multiples) times a log-tempo Gaussian centered near 120 BPM.
    const bpmAtLag = (FPS * 60) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpmAtLag / 120) / 0.9, 2));
    scores[lag] = s * w;
    if (scores[lag] > bestScore) {
      bestScore = scores[lag];
      bestLag = lag;
    }
  }

  // Parabolic interpolation around the peak for sub-sample lag (better BPM accuracy).
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = scores[bestLag - 1];
    const b = scores[bestLag];
    const c = scores[bestLag + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) refinedLag = bestLag + (0.5 * (a - c)) / denom;
  }

  const bpm = (FPS * 60) / refinedLag;
  const periodFrames = refinedLag;

  // Phase alignment: find the offset whose pulse train best hits the onsets.
  let bestOffset = 0;
  let bestPhase = -1;
  for (let off = 0; off < periodFrames; off++) {
    let s = 0;
    for (let f = Math.round(off); f < frames; f += periodFrames) s += onset[Math.round(f)] ?? 0;
    if (s > bestPhase) {
      bestPhase = s;
      bestOffset = off;
    }
  }

  // Emit beat timestamps across the window.
  const beats: number[] = [];
  const msPerFrame = (HOP / SR) * 1000;
  for (let f = bestOffset; f < frames; f += periodFrames) {
    const t = Math.round(f * msPerFrame);
    if (t <= durationMs) beats.push(t);
  }
  if (beats.length < 2) return null;

  return {
    bpm: Math.round(bpm * 10) / 10,
    durationMs,
    beats,
    sections: detectSections(energy, msPerFrame, durationMs),
  };
}

/** Light section detection: intro, a build, and the biggest energy lift = "drop". */
function detectSections(energy: Float64Array, msPerFrame: number, durationMs: number) {
  const frames = energy.length;
  // Smooth energy with a ~1s moving average.
  const win = Math.max(1, Math.round(FPS));
  const smooth = new Float64Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += energy[f];
    if (f >= win) acc -= energy[f - win];
    smooth[f] = acc / Math.min(f + 1, win);
  }
  // Drop = frame (after 30% in) with the largest rise over the preceding second.
  const start = Math.floor(frames * 0.3);
  let dropFrame = Math.floor(frames * 0.55);
  let bestRise = -Infinity;
  for (let f = start; f < frames; f++) {
    const rise = smooth[f] - smooth[Math.max(0, f - win)];
    if (rise > bestRise) {
      bestRise = rise;
      dropFrame = f;
    }
  }
  const dropMs = Math.min(durationMs - 1, Math.round(dropFrame * msPerFrame));
  return [
    { label: "intro", startMs: 0 },
    { label: "build", startMs: Math.round(durationMs * 0.15) },
    { label: "drop", startMs: dropMs },
  ];
}

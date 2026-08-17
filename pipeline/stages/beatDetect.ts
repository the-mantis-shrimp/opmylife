/**
 * beat.detect — analyze the prepared track into the beat grid (BPM, beat onsets,
 * section markers). This is the grid everything downstream cuts to. Writes
 * music_tracks.bpm / beat_grid / duration_ms.
 *
 * Next: director.storyboard.
 */
import { query, queryOne } from "../../lib/db";
import { setProjectStatus } from "../../lib/projects";
import { resolveTrim, renderMaxMs, opAudioKey } from "../../lib/music";
import { getObject } from "../../lib/storage";
import { detectBeatsFromAudio, syntheticGrid } from "../../lib/beat";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

export async function beatDetect(ctx: StageContext): Promise<void> {
  const track = await queryOne<{
    id: string; duration_ms: number | null; trim_start_ms: number | null; trim_end_ms: number | null;
  }>(
    `SELECT id, duration_ms, trim_start_ms, trim_end_ms FROM music_tracks WHERE project_id = $1 LIMIT 1`,
    [ctx.projectId],
  );
  if (!track) throw new Error("beat.detect: no music_tracks row for project.");

  // Grid over the EFFECTIVE window: full for finals, first 15s for previews.
  const window = resolveTrim(
    { durationMs: track.duration_ms, trimStartMs: track.trim_start_ms, trimEndMs: track.trim_end_ms },
    renderMaxMs(ctx.renderKind),
  );

  // Analyze the ACTUAL trimmed OP audio (produced by music.prepare) for real
  // tempo + beats. Fall back to a synthetic grid only if the audio is missing.
  let grid;
  try {
    const audio = await getObject(opAudioKey(ctx.projectId));
    grid = await detectBeatsFromAudio(audio, window.lengthMs);
  } catch (err) {
    log.warn("beat.detect: no trimmed audio, using synthetic grid", {
      projectId: ctx.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    grid = syntheticGrid(window.lengthMs);
  }
  // Write the grid + bpm only. duration_ms stays the FULL track length; the OP
  // length lives in the trim window + beat_grid.durationMs.
  await query(
    `UPDATE music_tracks SET bpm = $2, beat_grid = $3 WHERE id = $1`,
    [track.id, grid.bpm, JSON.stringify(grid)],
  );
  await setProjectStatus(ctx.projectId, "storyboarding");
  log.info("beat.detect ok", { projectId: ctx.projectId, bpm: grid.bpm, beats: grid.beats.length });

  await ctx.enqueue({ stage: "director.storyboard" });
}

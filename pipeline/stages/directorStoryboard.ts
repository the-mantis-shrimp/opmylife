/**
 * director.storyboard — plans the shot list. Two selectable modes
 * (`projects.mode`):
 *
 *   album-to-life: one shot per uploaded photo, used exactly once, in upload
 *     order — no clip reuse. Timing is computed here from the real beat grid;
 *     the LLM only chooses framing/motion per photo.
 *   animate-me: people can appear (and be REUSED) across multiple shots; a
 *     beat-driven shot list of variable length, optionally guided by the
 *     user's free-text `direction`.
 *
 * Both write storyboards.plan and derive `shots` rows for the active
 * render_kind. Idempotent via UNIQUE(project_id, render_kind, idx).
 *
 * Next: shots.generate (fan-out).
 */
import { query } from "../../lib/db";
import { directStoryboardAlbumToLife, directStoryboardAnimateMe } from "../../lib/models/vision";
import { isOpMode } from "../../lib/projects";
import { animateMeShotCount } from "../../lib/pricing";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";
import type { BeatGrid, AlbumAnalysis, StoryboardShot } from "../../lib/models/types";

interface PhotoRow {
  id: string;
  meta: { analysis?: { description?: string }; albumSummary?: string; palette?: string[] } | null;
}
interface CharRow { id: string; label: string | null; ref_r2_key: string | null; source_asset_ids: string[] }

/**
 * Pick n+1 cut points spanning [0, durationMs], preferring real beat timestamps.
 * Falls back to even time slices if there are fewer detected beats than photos
 * (shots don't need equal length, but must still land in-sync where possible).
 */
function pickCutPoints(beats: number[], durationMs: number, n: number): number[] {
  if (n <= 0) return [0, durationMs];
  if (beats.length - 1 >= n) {
    const points: number[] = [];
    for (let i = 0; i <= n; i++) {
      const beatIdx = Math.round((i * (beats.length - 1)) / n);
      points.push(beats[beatIdx]);
    }
    for (let i = 1; i < points.length; i++) {
      if (points[i] <= points[i - 1]) points[i] = points[i - 1] + 1;
    }
    points[points.length - 1] = durationMs;
    return points;
  }
  const points: number[] = [];
  for (let i = 0; i <= n; i++) points.push(Math.round((i * durationMs) / n));
  return points;
}

export async function directorStoryboard(ctx: StageContext): Promise<void> {
  const proj = await query<{ mode: string; direction: string | null }>(
    `SELECT mode, direction FROM projects WHERE id = $1`,
    [ctx.projectId],
  );
  const mode = isOpMode(proj[0]?.mode) ? proj[0].mode : "album-to-life";

  const characters = await query<CharRow>(
    `SELECT id, label, ref_r2_key, source_asset_ids FROM characters WHERE project_id = $1 ORDER BY created_at`,
    [ctx.projectId],
  );
  const trackRows = await query<{ beat_grid: BeatGrid }>(
    `SELECT beat_grid FROM music_tracks WHERE project_id = $1 LIMIT 1`,
    [ctx.projectId],
  );
  const beat = trackRows[0]?.beat_grid;
  if (!beat) throw new Error("director.storyboard: beat grid not ready.");

  const analysisRow = await query<{ meta: { palette?: string[]; albumSummary?: string } | null }>(
    `SELECT meta FROM assets WHERE project_id = $1 AND meta IS NOT NULL LIMIT 1`,
    [ctx.projectId],
  );
  const analysis: AlbumAnalysis = {
    summary: analysisRow[0]?.meta?.albumSummary ?? "",
    mood: "uplifting, nostalgic",
    palette: analysisRow[0]?.meta?.palette ?? [],
    perAsset: {},
  };

  const planResult = mode === "album-to-life"
    ? await planAlbumToLife(ctx.projectId, characters, beat, analysis)
    : await planAnimateMe(characters, beat, analysis, proj[0]?.direction ?? undefined);

  const plan = { shots: planResult.shots, titleCardAtMs: planResult.titleCardAtMs, notes: planResult.notes };
  await query(`INSERT INTO storyboards (project_id, plan) VALUES ($1, $2)`, [ctx.projectId, JSON.stringify(plan)]);

  // album-to-life: each shot animates ITS photo's own stylized reference (attire
  // varies per shot), and carries that photo's DESCRIPTION so i2v animates the
  // actual scene/action. animate-me: each shot uses the character's shared ref.
  const photoRefByAsset = new Map<string, string | null>();
  const photoDescByAsset = new Map<string, string>();
  if (mode === "album-to-life") {
    const refs = await query<{ id: string; ref_r2_key: string | null; meta: { analysis?: { description?: string } } | null }>(
      `SELECT id, ref_r2_key, meta FROM assets WHERE project_id = $1 AND kind = 'photo'`,
      [ctx.projectId],
    );
    for (const r of refs) {
      photoRefByAsset.set(r.id, r.ref_r2_key);
      if (r.meta?.analysis?.description) photoDescByAsset.set(r.id, r.meta.analysis.description);
    }
  }

  for (const shot of plan.shots) {
    const character = shot.characterIdx >= 0 ? characters[shot.characterIdx] : undefined;
    const refKey =
      mode === "album-to-life" && shot.assetId
        ? photoRefByAsset.get(shot.assetId) ?? null
        : character?.ref_r2_key ?? null;
    const description = shot.assetId ? photoDescByAsset.get(shot.assetId) ?? null : null;
    const prompt = {
      refKey,
      shotType: shot.shotType,
      motion: shot.motion,
      description, // photo context → grounds the i2v animation (album-to-life)
      scene: shot.scene ?? null, // the NEW scene to compose the character into (animate-me)
      assetId: shot.assetId ?? null,
      modelRoute: ctx.renderKind === "final" ? "i2v-production" : "i2v-preview-cheap",
    };
    await query(
      `INSERT INTO shots (project_id, idx, render_kind, character_id, start_ms, end_ms, prompt)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (project_id, render_kind, idx) DO UPDATE SET start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms`,
      [ctx.projectId, shot.idx, ctx.renderKind, character?.id ?? null, shot.startMs, shot.endMs, JSON.stringify(prompt)],
    );
  }

  log.info("director.storyboard ok", { projectId: ctx.projectId, mode, shots: plan.shots.length });

  await ctx.enqueue({ stage: "shots.generate" });
}

/** album-to-life: one shot per validated photo, used exactly once. */
async function planAlbumToLife(
  projectId: string,
  characters: CharRow[],
  beat: BeatGrid,
  analysis: AlbumAnalysis,
): Promise<{ shots: StoryboardShot[]; titleCardAtMs: number; notes: string }> {
  const photos = await query<PhotoRow>(
    `SELECT id, meta FROM assets
       WHERE project_id = $1 AND kind = 'photo' AND validated = true
       ORDER BY position, created_at`,
    [projectId],
  );
  if (photos.length === 0) throw new Error("director.storyboard: no validated photos to build shots from.");

  // Reverse map: which character owns each photo (for labeling + shots.character_id
  // + the SHARED per-character reference — identity stays consistent across shots).
  const owner = new Map<string, { characterIdx: number; label: string }>();
  characters.forEach((c, characterIdx) => {
    for (const assetId of c.source_asset_ids) {
      owner.set(assetId, { characterIdx, label: c.label ?? `Character ${characterIdx + 1}` });
    }
  });

  const photosForDirector = photos.map((p, idx) => ({
    idx,
    label: owner.get(p.id)?.label ?? "Character",
    description: p.meta?.analysis?.description ?? "",
  }));

  const creative = await directStoryboardAlbumToLife(photosForDirector, beat, analysis);
  const creativeByIdx = new Map(creative.shots.map((s) => [s.idx, s]));

  const beats = beat.beats.length > 1 ? beat.beats : [0, beat.durationMs];
  const cutPoints = pickCutPoints(beats, beat.durationMs, photos.length);

  const shots: StoryboardShot[] = photos.map((p, i) => {
    const c = creativeByIdx.get(i);
    const own = owner.get(p.id);
    return {
      idx: i,
      startMs: Math.round(cutPoints[i]),
      endMs: Math.round(cutPoints[i + 1]),
      assetId: p.id,
      characterIdx: own?.characterIdx ?? -1,
      shotType: c?.shotType || (i % 2 === 0 ? "close-up" : "wide"),
      motion: c?.motion || (i % 3 === 0 ? "slow push-in" : "pan"),
    };
  });

  const sectionStarts = beat.sections.map((s) => s.startMs);
  const titleCardAtMs =
    sectionStarts.length > 0
      ? sectionStarts.reduce((best, s) => (Math.abs(s - creative.titleCardAtMs) < Math.abs(best - creative.titleCardAtMs) ? s : best), sectionStarts[0])
      : creative.titleCardAtMs;

  return { shots, titleCardAtMs, notes: creative.notes };
}

/** animate-me: beat-driven shot list; characters can repeat/reuse; user direction. */
async function planAnimateMe(
  characters: CharRow[],
  beat: BeatGrid,
  analysis: AlbumAnalysis,
  direction: string | undefined,
): Promise<{ shots: StoryboardShot[]; titleCardAtMs: number; notes: string }> {
  // Fix the shot count to the price quote (animateMeShotCount) — same number the
  // user was charged for. No reuse; each shot is a fresh scene.
  const out = await directStoryboardAnimateMe(
    characters.map((c, idx) => ({ idx, label: c.label ?? `Character ${idx + 1}` })),
    beat,
    analysis,
    animateMeShotCount(beat.durationMs),
    direction,
  );
  const shots: StoryboardShot[] = out.shots.map((s) => ({
    idx: s.idx,
    startMs: s.startMs,
    endMs: s.endMs,
    characterIdx: s.characterIdx,
    shotType: s.shotType,
    motion: s.motion,
    scene: s.scene,
  }));
  return { shots, titleCardAtMs: out.titleCardAtMs, notes: out.notes };
}

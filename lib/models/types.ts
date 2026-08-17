/** Shared shapes for the model gateway clients (vision, image+i2v, music). */

export interface AlbumAnalysis {
  summary: string;
  mood: string;
  palette: string[];
  /** Per-asset hints keyed by asset id — fed to stylize + director. */
  perAsset: Record<string, { description: string; hasFace: boolean }>;
}

export interface FaceCluster {
  /** Photos (asset ids) grouped as one person. */
  assetIds: string[];
  suggestedLabel: string;
}

export interface StylizeResult {
  refKey: string; // R2 key of the stylized character reference image
  styleMeta: { prompt: string; seed: number; model: string; style?: string };
}

export interface BeatGrid {
  bpm: number;
  durationMs: number;
  /** Beat onset timestamps (ms). */
  beats: number[];
  /** Section boundaries: intro/verse/drop etc. */
  sections: { label: string; startMs: number }[];
}

// ── director.storyboard — two selectable modes (projects.mode) ───────────────
//
// album-to-life: one shot per uploaded photo, used exactly once, in upload
//   order — no clip reuse. The director only chooses framing/motion per photo;
//   timing/assignment is computed in code from the real beat grid.
// animate-me: characters can appear (and be REUSED) across multiple shots; the
//   director plans a beat-driven shot list of variable length, optionally
//   guided by the user's free-text `direction`.
//
// Both ultimately produce the same StoryboardPlan/StoryboardShot shape for
// storage — only how the LLM's creative output is combined with computed
// timing/identity differs.

/** album-to-life: the LLM's per-photo creative choice only. */
export interface StoryboardShotCreative {
  idx: number; // 0-based, matches the photo order given to the director
  shotType: string;
  motion: string;
}

export interface DirectorPhotoOutput {
  shots: StoryboardShotCreative[];
  titleCardAtMs: number;
  notes: string;
}

/** animate-me: code fixes the shot COUNT + timing; the LLM fills the creative. */
export interface StoryboardShotPlanned {
  idx: number;
  startMs: number;
  endMs: number;
  characterIdx: number; // 0-based index into the provided character list
  shotType: string;
  motion: string;
  /** The NEW scene (setting + action) to place the character into — the whole
   *  point of animate-me: characters from the photos, in fresh scenes. */
  scene?: string;
}

export interface DirectorCharacterOutput {
  shots: StoryboardShotPlanned[];
  titleCardAtMs: number;
  notes: string;
}

/** Fully computed shot, written to storyboards.plan + shots rows (both modes). */
export interface StoryboardShot {
  idx: number;
  startMs: number;
  endMs: number;
  characterIdx: number; // -1 if no owning character was found (edge case)
  shotType: string;
  motion: string;
  assetId?: string; // set in album-to-life mode (traceability: which photo)
  scene?: string; // set in animate-me mode (the new scene to compose the character into)
}

export interface StoryboardPlan {
  shots: StoryboardShot[];
  titleCardAtMs: number;
  notes: string;
}

export interface ShotClipResult {
  clipKey: string; // R2 key of the generated clip
}

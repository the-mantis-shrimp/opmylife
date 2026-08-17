/**
 * Vision LLM client: album analysis, the consent-gated face clustering, and the
 * director/storyboard pass.
 *
 * Live mode (VISION_MODE=live or MODELS_MODE=live) uses Claude (Opus 4.8 by
 * default, override with VISION_LLM_MODEL) via the official Anthropic SDK:
 *   - photos are fetched from R2 and sent as base64 image blocks
 *   - responses are constrained to JSON via structured outputs
 *     (output_config.format json_schema), then validated/sanitized in code —
 *     beat alignment is ENFORCED here by snapping cut points to the grid, never
 *     trusted from the model.
 *
 * Stub mode returns deterministic data so the pipeline runs with zero spend.
 */
import { env } from "../env";
import { log } from "../logger";
import type {
  AlbumAnalysis,
  FaceCluster,
  BeatGrid,
  DirectorPhotoOutput,
  DirectorCharacterOutput,
  StoryboardShotCreative,
  StoryboardShotPlanned,
} from "./types";

interface PhotoRef {
  assetId: string;
  r2Key: string;
  mime?: string | null;
  meta?: Record<string, unknown>;
}

// ── Anthropic client (lazy, memoized; only loaded on the live path) ──────────
type AnthropicClient = InstanceType<typeof import("@anthropic-ai/sdk").default>;
let _client: AnthropicClient | null = null;

async function anthropic(): Promise<AnthropicClient> {
  if (_client) return _client;
  if (!env.visionLlmKey) {
    throw new Error("VISION_LLM_KEY is not set — required when vision mode is live.");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  _client = new Anthropic({ apiKey: env.visionLlmKey });
  return _client;
}

// ── Image plumbing ────────────────────────────────────────────────────────────
// API-supported image media types. HEIC/HEIF pass ingest but can't be sent to
// the model — they're skipped with a warning (conversion is a later pass).
const SUPPORTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // per-image guard (API request cap is 32MB)
const MAX_REQUEST_IMAGE_BYTES = 22 * 1024 * 1024; // cumulative budget per request

function mimeFor(photo: PhotoRef): string {
  if (photo.mime) return photo.mime;
  const ext = photo.r2Key.split(".").pop()?.toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[
    ext ?? ""
  ] ?? "application/octet-stream";
}

/**
 * Load photos as image content blocks, each preceded by a "Photo N" label so
 * the model can reference them by index. Skips unsupported/oversized files.
 * Returns the blocks plus the subset of photos actually included (index-aligned).
 */
async function imageBlocks(photos: PhotoRef[]) {
  const { getObject } = await import("../storage");
  const blocks: unknown[] = [];
  const included: PhotoRef[] = [];
  let budget = MAX_REQUEST_IMAGE_BYTES;

  for (const photo of photos) {
    const mime = mimeFor(photo);
    if (!SUPPORTED_IMAGE_MIME.has(mime)) {
      log.warn("vision: skipping unsupported image type", { assetId: photo.assetId, mime });
      continue;
    }
    const bytes = await getObject(photo.r2Key);
    if (bytes.length > MAX_IMAGE_BYTES || bytes.length > budget) {
      log.warn("vision: skipping oversized image", { assetId: photo.assetId, bytes: bytes.length });
      continue;
    }
    budget -= bytes.length;
    blocks.push({ type: "text", text: `Photo ${included.length + 1}:` });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: mime, data: bytes.toString("base64") },
    });
    included.push(photo);
  }
  if (included.length === 0) {
    throw new Error("vision: no photos usable by the model (unsupported types or too large).");
  }
  return { blocks, included };
}

/** Run a structured-output request and parse the JSON text block. */
async function structuredRequest<T>(args: {
  system: string;
  content: unknown;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  const client = await anthropic();
  const response = await client.messages.create({
    model: env.visionLlmModel,
    max_tokens: args.maxTokens ?? 16000,
    thinking: { type: "adaptive" },
    system: args.system,
    output_config: { format: { type: "json_schema", schema: args.schema } },
    messages: [{ role: "user", content: args.content as never }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("vision: model declined the request (stop_reason=refusal).");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("vision: response truncated (max_tokens) — output may be incomplete.");
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("vision: no text block in model response.");
  return JSON.parse(text.text) as T;
}

// ── album.analyze ─────────────────────────────────────────────────────────────

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "mood", "palette", "photos"],
  properties: {
    summary: { type: "string", description: "2-3 sentence description of the album as a whole" },
    mood: { type: "string", description: "short mood/aesthetic phrase, e.g. 'uplifting, nostalgic'" },
    palette: {
      type: "array",
      description: "4-6 hex colors capturing the album's aesthetic",
      items: { type: "string" },
    },
    photos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "description", "hasFace"],
        properties: {
          index: { type: "integer", description: "1-based Photo N label" },
          description: { type: "string", description: "one-sentence scene/person/mood description" },
          hasFace: { type: "boolean" },
        },
      },
    },
  },
} as const;

interface AnalysisOut {
  summary: string;
  mood: string;
  palette: string[];
  photos: { index: number; description: string; hasFace: boolean }[];
}

export async function analyzeAlbum(photos: PhotoRef[]): Promise<AlbumAnalysis> {
  if (env.visionMode === "live") {
    const { blocks, included } = await imageBlocks(photos);
    const out = await structuredRequest<AnalysisOut>({
      system:
        "You are analyzing a personal photo album that will become the cast and mood reference for a ~90 second anime opening title sequence. Describe what is actually in the photos — people, settings, mood, light, color. Your hints feed a character stylizer and a storyboard director downstream.",
      content: [
        ...blocks,
        {
          type: "text",
          text: `Analyze these ${included.length} photos. For each photo give a one-sentence description and whether a human face is clearly visible. Then summarize the album, its mood, and a color palette.`,
        },
      ],
      schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
    });

    const perAsset: AlbumAnalysis["perAsset"] = {};
    for (const p of out.photos) {
      const photo = included[p.index - 1];
      if (photo) perAsset[photo.assetId] = { description: p.description, hasFace: p.hasFace };
    }
    // Photos the model skipped (or we excluded) still get a neutral hint.
    for (const photo of photos) {
      perAsset[photo.assetId] ??= { description: "Photo (not analyzed).", hasFace: false };
    }
    log.info("vision.analyzeAlbum live ok", { photos: photos.length, analyzed: included.length });
    return { summary: out.summary, mood: out.mood, palette: out.palette, perAsset };
  }

  // Stub: deterministic per-asset hints.
  const perAsset: AlbumAnalysis["perAsset"] = {};
  photos.forEach((p, i) => {
    perAsset[p.assetId] = {
      description: `Photo ${i + 1}: warm candid portrait, soft daylight.`,
      hasFace: true,
    };
  });
  return {
    summary: `Album of ${photos.length} candid photos of close friends/family.`,
    mood: "uplifting, nostalgic",
    palette: ["#ff6b9d", "#ffd166", "#06d6a0", "#118ab2"],
    perAsset,
  };
}

// ── faces.cluster (CONSENT-GATED) ─────────────────────────────────────────────

const CLUSTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clusters"],
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "indices"],
        properties: {
          label: { type: "string", description: "short neutral label, e.g. 'Person A'" },
          indices: {
            type: "array",
            description: "1-based Photo N indices in which this same person appears",
            items: { type: "integer" },
          },
        },
      },
    },
  },
} as const;

/**
 * Face clustering — CONSENT-GATED. The caller (faces.cluster stage) must verify
 * a granted biometric consent row BEFORE invoking this. Never call without it.
 */
export async function clusterFaces(photos: PhotoRef[]): Promise<FaceCluster[]> {
  if (env.visionMode === "live") {
    const { blocks, included } = await imageBlocks(photos);
    const out = await structuredRequest<{ clusters: { label: string; indices: number[] }[] }>({
      system:
        "You group photos of a personal album by which distinct person appears in them, to build the cast of a personalized anime opening. The user has given explicit biometric consent for this grouping. A photo may appear in multiple groups if multiple people are prominent in it. Only group by clearly visible people; ignore background strangers.",
      content: [
        ...blocks,
        {
          type: "text",
          text: `Group these ${included.length} photos by distinct person (at most 5 people, the most prominent across the album). Use neutral labels like "Person A".`,
        },
      ],
      schema: CLUSTER_SCHEMA as unknown as Record<string, unknown>,
    });

    const clusters: FaceCluster[] = out.clusters
      .map((c) => ({
        suggestedLabel: c.label,
        assetIds: c.indices
          .map((i) => included[i - 1]?.assetId)
          .filter((id): id is string => !!id),
      }))
      .filter((c) => c.assetIds.length > 0)
      .slice(0, 5);
    if (clusters.length === 0) throw new Error("vision.clusterFaces: model found no people to cluster.");
    log.info("vision.clusterFaces live ok", { photos: included.length, clusters: clusters.length });
    return clusters;
  }

  // Stub: split photos into up to 3 deterministic clusters by index.
  const k = Math.min(3, Math.max(1, photos.length));
  const clusters: FaceCluster[] = Array.from({ length: k }, (_, i) => ({
    assetIds: [],
    suggestedLabel: `Character ${i + 1}`,
  }));
  photos.forEach((p, i) => clusters[i % k].assetIds.push(p.assetId));
  return clusters.filter((c) => c.assetIds.length > 0);
}

// ── director.storyboard: album-to-life mode ───────────────────────────────────
// One shot per uploaded photo, used exactly once — no clip reuse. The director
// only picks the CREATIVE fields (shotType/motion) per photo; the pipeline stage
// computes exact timing from the real beat grid and never trusts the model for
// counts, so the shot count always equals the photo count.

const PHOTO_STORYBOARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["shots", "titleCardAtMs", "notes"],
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["idx", "shotType", "motion"],
        properties: {
          idx: { type: "integer", description: "0-based index matching the photo order given (PHOTO idx)" },
          shotType: { type: "string", description: "e.g. close-up, wide, medium, over-shoulder, action" },
          motion: { type: "string", description: "camera/subject motion, e.g. 'slow push-in', 'whip pan'" },
        },
      },
    },
    titleCardAtMs: { type: "integer", description: "when the title card lands — must be a section boundary" },
    notes: { type: "string" },
  },
} as const;

/** Snap a time to the nearest value in a list (used only for the title card). */
function snapTo(ms: number, candidates: number[]): number {
  if (candidates.length === 0) return ms;
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c - ms) < Math.abs(best - ms)) best = c;
  return best;
}

/**
 * Director/storyboard. One PHOTO = one SHOT, used exactly once (no reuse — every
 * uploaded photo appears in the video). Given photos in final shot order (each
 * tagged with its owning character + per-photo description), the director only
 * chooses framing (shotType) and motion for each — timing/assignment is fixed by
 * the pipeline stage from the real photo list and beat grid.
 */
export async function directStoryboardAlbumToLife(
  photos: { idx: number; label: string; description: string }[],
  beat: BeatGrid,
  analysis: AlbumAnalysis,
): Promise<DirectorPhotoOutput> {
  const n = photos.length;
  if (env.visionMode === "live") {
    const out = await structuredRequest<{ shots: StoryboardShotCreative[]; titleCardAtMs: number; notes: string }>({
      system:
        "You are the director of an anime opening (OP) title sequence. There is EXACTLY one shot per photo, in the given order — shot i shows the same person/moment as Photo i. Don't invent extra shots, skip any, or reorder them. Your only job per shot is choosing a shotType (framing) and motion (camera/subject movement) an image-to-video model can execute, matching that photo's content and building energy across the sequence.",
      content: [
        {
          type: "text",
          text: [
            `PHOTOS in final shot order (idx: character — description):`,
            photos.map((p) => `${p.idx}: ${p.label} — ${p.description || "no description"}`).join("\n"),
            `MUSIC: ${beat.bpm} BPM, duration ${beat.durationMs}ms.`,
            `SECTIONS: ${beat.sections.map((s) => `${s.label}@${s.startMs}ms`).join(", ")}`,
            `ALBUM MOOD: ${analysis.mood}. Palette: ${analysis.palette.join(" ")}`,
            "",
            `Return exactly ${n} shots, one per photo idx 0..${n - 1}, each with a shotType and motion. Also choose titleCardAtMs (should land on a section boundary above).`,
          ].join("\n"),
        },
      ],
      schema: PHOTO_STORYBOARD_SCHEMA as unknown as Record<string, unknown>,
    });

    // Sanitize: guarantee exactly one creative entry per photo, regardless of
    // what the model returned (never trust it for count/index correctness).
    const byIdx = new Map(out.shots.map((s) => [s.idx, s]));
    const shots: StoryboardShotCreative[] = photos.map((p) => {
      const s = byIdx.get(p.idx);
      return {
        idx: p.idx,
        shotType: s?.shotType || (p.idx % 2 === 0 ? "close-up" : "wide"),
        motion: s?.motion || (p.idx % 3 === 0 ? "slow push-in" : "pan"),
      };
    });

    const sectionStarts = beat.sections.map((s) => s.startMs);
    const titleCardAtMs = sectionStarts.length > 0 ? snapTo(out.titleCardAtMs, sectionStarts) : out.titleCardAtMs;

    log.info("vision.directStoryboardAlbumToLife live ok", { shots: shots.length });
    return { shots, titleCardAtMs, notes: out.notes };
  }

  // Stub: deterministic shotType/motion per photo, no reuse.
  const shots: StoryboardShotCreative[] = photos.map((p) => ({
    idx: p.idx,
    shotType: p.idx % 2 === 0 ? "close-up" : "wide",
    motion: p.idx % 3 === 0 ? "slow push-in" : "pan",
  }));
  const titleSection = beat.sections.find((s) => s.startMs > 0) ?? { startMs: Math.floor(beat.durationMs * 0.15) };
  return {
    shots,
    titleCardAtMs: titleSection.startMs,
    notes: `Storyboard: ${shots.length} shots (one per photo), cut to ${beat.bpm} BPM. ${analysis.mood}.`,
  };
}

// ── director.storyboard: animate-me mode ──────────────────────────────────────
// The cast (people from the uploaded photos, grouped into `characters`) is placed
// into ENTIRELY NEW SCENES that follow the user's `direction`. CODE fixes the shot
// COUNT (targetShots, == the price quote) and the timing (even cuts snapped to the
// beat grid); the LLM only chooses, per shot, which cast member appears + the new
// scene + framing/motion. No clip reuse — every shot is its own fresh scene.

const CHARACTER_STORYBOARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["shots", "titleCardAtMs", "notes"],
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["idx", "characterIdx", "scene", "shotType", "motion"],
        properties: {
          idx: { type: "integer", description: "0-based shot index, 0..N-1" },
          characterIdx: { type: "integer", description: "0-based index into the cast list — who appears in this shot" },
          scene: {
            type: "string",
            description:
              "the NEW scene to put the character into: the setting/environment + what they are doing, following the user's direction (e.g. 'sprinting across a neon rooftop at night, coat flaring')",
          },
          shotType: { type: "string", description: "e.g. close-up, wide, medium, over-shoulder, action" },
          motion: { type: "string", description: "camera/subject motion, e.g. 'slow push-in', 'whip pan'" },
        },
      },
    },
    titleCardAtMs: { type: "integer", description: "when the title card lands — a section boundary" },
    notes: { type: "string" },
  },
} as const;

/** Snap a time to the nearest beat in the grid (code-enforced beat sync). */
function snapToBeat(ms: number, beats: number[]): number {
  return snapTo(ms, beats);
}

export async function directStoryboardAnimateMe(
  characters: { idx: number; label: string }[],
  beat: BeatGrid,
  analysis: AlbumAnalysis,
  targetShots: number,
  direction?: string,
): Promise<DirectorCharacterOutput> {
  const n = Math.max(1, targetShots);
  const beats = beat.beats.length > 1 ? beat.beats : [0, beat.durationMs];
  // Even cut points across the duration, snapped to real beats — CODE owns timing
  // and the exact count, so it always matches the price quote.
  const windows = Array.from({ length: n }, (_, i) => {
    const startMs = Math.round(snapToBeat((i / n) * beat.durationMs, beats));
    let endMs = Math.round(i === n - 1 ? beat.durationMs : snapToBeat(((i + 1) / n) * beat.durationMs, beats));
    if (endMs <= startMs) endMs = Math.min(beat.durationMs, startMs + Math.round(60_000 / beat.bpm));
    return { startMs, endMs };
  });
  const sectionStarts = beat.sections.map((s) => s.startMs);
  const defaultTitleAt = beat.sections.find((s) => s.startMs > 0)?.startMs ?? Math.floor(beat.durationMs * 0.15);

  interface CreativeShot { idx: number; characterIdx: number; scene: string; shotType: string; motion: string }
  let creative: CreativeShot[] = [];
  let titleCardAtMs = defaultTitleAt;
  let notes = `${n} shots. ${analysis.mood}.${direction ? ` Direction: ${direction}` : ""}`;

  if (env.visionMode === "live") {
    const out = await structuredRequest<{ shots: CreativeShot[]; titleCardAtMs: number; notes: string }>({
      system:
        "You are the director of a ~90 second anime opening (OP). The cast is a set of real people from the user's photos. Your job is to place these characters into ENTIRELY NEW SCENES that match the user's creative direction — new settings, environments, and action, NOT their original photos. Feature every cast member, build energy across the sequence, and vary the scenes (no repeats)." +
        (direction ? ` The user's creative direction — follow it closely: "${direction}"` : " Invent a fun, cohesive concept if no direction is given."),
      content: [
        {
          type: "text",
          text: [
            `CAST (index: label): ${characters.map((c) => `${c.idx}: ${c.label}`).join(", ") || "0: Character 1"}`,
            `MUSIC: ${beat.bpm} BPM, duration ${beat.durationMs}ms. SECTIONS: ${beat.sections.map((s) => `${s.label}@${s.startMs}ms`).join(", ")}`,
            `MOOD: ${analysis.mood}. Palette: ${analysis.palette.join(" ")}`,
            direction ? `USER DIRECTION: ${direction}` : "",
            "",
            `Return EXACTLY ${n} shots, idx 0..${n - 1}. For each: characterIdx (who appears), a NEW scene (setting + action following the direction), a shotType, and a motion an image-to-video model can execute. Also choose titleCardAtMs on a section boundary.`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      schema: CHARACTER_STORYBOARD_SCHEMA as unknown as Record<string, unknown>,
    });
    creative = out.shots ?? [];
    if (sectionStarts.length > 0) titleCardAtMs = snapToBeat(out.titleCardAtMs, sectionStarts);
    if (out.notes) notes = out.notes;
  }

  // Merge: CODE guarantees exactly n shots with fixed timing; the LLM fills the
  // creative per idx (with safe fallbacks). No reuse — each is its own scene.
  const byIdx = new Map(creative.map((c) => [c.idx, c]));
  const maxChar = Math.max(0, characters.length - 1);
  const shots: StoryboardShotPlanned[] = windows.map((w, i) => {
    const c = byIdx.get(i);
    return {
      idx: i,
      startMs: w.startMs,
      endMs: w.endMs,
      characterIdx: Math.max(0, Math.min(c?.characterIdx ?? (characters.length ? i % characters.length : 0), maxChar)),
      shotType: c?.shotType || (i % 2 === 0 ? "close-up" : "wide"),
      motion: c?.motion || (i % 3 === 0 ? "slow push-in" : "pan"),
      scene: c?.scene || direction || analysis.summary || "a dynamic anime opening scene",
    };
  });

  log.info("vision.directStoryboardAnimateMe ok", { shots: shots.length, live: env.visionMode === "live", hasDirection: !!direction });
  return { shots, titleCardAtMs, notes };
}

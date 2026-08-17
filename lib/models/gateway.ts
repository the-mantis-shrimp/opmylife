/**
 * Image + image-to-video gateway.
 *
 * Live mode (GATEWAY_MODE=live or MODELS_MODE=live) uses fal.ai — ONE
 * integration behind which any hosted model is routable per shot via env:
 *   IMAGE_MODEL        photo → anime character reference (default nano-banana/edit)
 *   I2V_MODEL_PREVIEW  cheap i2v route for free watermarked previews (Kling standard)
 *   I2V_MODEL_FINAL    premium i2v route for charged finals (Kling pro; set a
 *                      Veo endpoint here to render finals on Google's model)
 *
 * Media flows: R2 objects are handed to fal as presigned GET URLs; results are
 * downloaded and stored back to R2. MODELS stub mode synthesizes deterministic
 * placeholder media with ffmpeg so the full pipeline runs with no spend.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { env } from "../env";
import { buildKey, putObject, getObject, presignDownload } from "../storage";
import { ffmpegAvailable, runFfmpeg, workDir, readFile, join } from "../media";
import { log } from "../logger";
import type { OpStyle } from "../projects";
import { IMAGE_MODELS, FALLBACK_IMAGE_MODEL, aspectDims } from "../projects";
import type { StylizeResult, ShotClipResult } from "./types";

/**
 * Per-style art direction. `redraw === null` (original) means DON'T run the image
 * model — the person's real photo is used as the reference and the i2v model
 * animates it unaltered. `medium` is the strong "make it look drawn, NOT a photo"
 * clause (nano-banana and most editors are conservative — they need to be told
 * explicitly to fully re-render, or they keep it photographic). `motion` is the
 * visual descriptor injected into every shot's i2v prompt.
 */
const STYLE_DEF: Record<OpStyle, { redraw: string | null; medium: string; motion: string }> = {
  original: {
    redraw: null,
    medium: "",
    motion: "cinematic live-action; keep the person's real, photographic appearance unaltered",
  },
  pixar: {
    redraw: "Completely re-render this person as a polished 3D animated-movie cartoon character",
    medium:
      "It must look like a frame from a modern 3D animated movie — fully CGI, NOT a photograph and not photorealistic. " +
      "Stylized rounded proportions, large expressive eyes, and smooth shaded/subsurface skin with a soft MATTE finish " +
      "— not shiny, glossy, wet, or hard plastic. Warm, soft cinematic studio lighting on a stylized cartoon face.",
    motion: "polished 3D animated-movie style, soft cinematic lighting, matte (non-plastic) skin, smooth expressive motion",
  },
  anime: {
    redraw: "Completely redraw this person as a 2D hand-drawn anime character in the style of a modern anime series",
    medium:
      "It must look like a frame from a high-quality anime — flat cel shading with clean, hard-edged shadow shapes, " +
      "bold crisp ink linework, vibrant saturated colors, and stylized anime features: large expressive eyes with " +
      "detailed catchlights, sharp flowing anime hair with gradient shading, a simplified small nose and mouth, and " +
      "smooth flat skin with NO photographic texture or pores. Fully illustrated 2D anime art — absolutely NOT a " +
      "photograph, NOT 3D/CGI, and NOT photorealistic. Redraw every part of the image, including the background, in " +
      "this 2D anime style.",
    motion:
      "animate it like a high-energy anime opening — lively, dynamic movement with expressive body and facial " +
      "animation, flowing hair and clothing, blowing wind, and sweeping camera motion; cel-shaded 2D anime with " +
      "dramatic lighting. Do not leave it as a static drawing.",
  },
  fantasy: {
    redraw: "Completely repaint this person as an epic fantasy character in a painterly, illustrated fantasy art style",
    medium:
      "It must look like a frame from an epic fantasy animated film or a piece of painterly fantasy concept art — richly " +
      "illustrated with visible painterly brushwork, dramatic magical lighting with glowing rim light and atmospheric haze, " +
      "ornate fantasy costuming and detail (flowing cloaks, leather and metal, subtle runes or jewelry as fitting), and a " +
      "lush, detailed fantasy backdrop. Heroic, cinematic mood. Hand-painted illustrated look — absolutely NOT a photograph " +
      "and not photorealistic. Repaint every part of the image, including the background, in this fantasy art style.",
    motion:
      "sweeping, cinematic fantasy motion — flowing cloaks and hair, drifting embers and motes of magical light, shifting " +
      "atmospheric haze and god-ray lighting, with an epic dramatic camera move; painterly illustrated fantasy style. Do not " +
      "leave it as a static image.",
  },
  // Custom: the art style comes from the user's uploaded style references. The
  // redraw is intentionally generic (no anime/pixar bias) — the STYLE reference
  // block appended below is what actually defines the look.
  reference: {
    redraw: "Completely redraw this person as a stylized illustration for an opening title sequence",
    medium: "It must be drawn/painted artwork — NOT a photograph and not photorealistic.",
    motion: "stylized animation, smooth motion consistent with the established art style",
  },
};

/**
 * Per-model-family input adapter for the stylization (image edit) call. fal image
 * editors disagree on the image field: Gemini/nano-banana take `image_urls` (an
 * array); FLUX Kontext takes a single `image_url`. Build the right shape so a
 * model swap (incl. the content-flag fallback) doesn't send an invalid request.
 */
function imageInput(endpoint: string, prompt: string, imageUrls: string[]): Record<string, unknown> {
  if (endpoint.includes("kontext")) {
    // Kontext edits ONE image; the target photo anchors identity on its own.
    return { prompt, image_url: imageUrls[0], num_images: 1, output_format: "png" };
  }
  return { prompt, image_urls: imageUrls, num_images: 1, output_format: "png" };
}

// ── fal client (lazy, memoized; only loaded on the live path) ────────────────
let _fal: typeof import("@fal-ai/client").fal | null = null;
async function falClient() {
  if (_fal) return _fal;
  if (!env.modelGatewayKey) {
    throw new Error("MODEL_GATEWAY_KEY is not set — required when gateway mode is live.");
  }
  const { fal } = await import("@fal-ai/client");
  fal.config({ credentials: env.modelGatewayKey });
  _fal = fal;
  return _fal;
}

/** Download a generated asset from the model provider's result URL. */
async function fetchResult(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gateway: failed to download result (${res.status}) from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * fal throws terse errors (e.g. bare "Unprocessable Entity" for a 422) but carries
 * the real reason on `.status` + `.body.detail` (FastAPI-style validation errors).
 * Flatten that into a readable string so a rejected request tells us WHICH field
 * the model refused, instead of a generic message that lands in the job error.
 */
function describeFalError(err: unknown): string {
  const e = err as { status?: number; message?: string; body?: unknown };
  const status = typeof e?.status === "number" ? `HTTP ${e.status}` : "";
  const body = e?.body as { detail?: unknown } | string | undefined;
  let detail = "";
  const d = typeof body === "object" && body ? (body as { detail?: unknown }).detail : undefined;
  if (Array.isArray(d)) {
    detail = d
      .map((x) => {
        const item = x as { loc?: unknown[]; msg?: string };
        const loc = Array.isArray(item?.loc) ? item.loc.filter((p) => p !== "body").join(".") : "";
        return [loc, item?.msg].filter(Boolean).join(": ");
      })
      .join("; ");
  } else if (typeof d === "string") {
    detail = d;
  } else if (typeof body === "string") {
    detail = body;
  } else if (body) {
    detail = JSON.stringify(body);
  }
  return [status, detail || e?.message].filter(Boolean).join(" — ") || String(err);
}

function colorFor(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex");
  return `#${h.slice(0, 6)}`;
}

// ── characters.stylize ────────────────────────────────────────────────────────

/** Turn a person into a consistent CHARACTER REFERENCE image in the chosen style.
 *  Identity consistency across shots is a core quality lever — the same ref is
 *  reused for every one of that character's shots. For style='original' the real
 *  photo IS the reference (no image-model call, no spend). */
export async function stylizeCharacter(args: {
  projectId: string;
  characterId: string;
  label: string;
  sourceKeys: string[];
  style: OpStyle;
  /**
   * album-to-life: preserve THIS photo's outfit/pose/background while anchoring
   * the FACE to `anchorKey` (a canonical photo of the same person), so attire
   * varies shot-to-shot but identity stays consistent. Omitted for animate-me,
   * which builds one shared character reference from the source photos.
   */
  anchorKey?: string;
  preserveContent?: boolean;
  /** User-selected stylization endpoint (projects.image_model); null = env default. */
  modelEndpoint?: string | null;
  /**
   * Optional user-supplied style reference images (R2 keys). When present, the
   * model is told to MATCH their art style — layered on top of the style preset,
   * so the user can dial in a specific look ("make it look like THIS").
   */
  styleRefKeys?: string[];
}): Promise<StylizeResult> {
  const def = STYLE_DEF[args.style];
  const imageModel = args.modelEndpoint ?? env.imageModel;

  // Original style: skip stylization entirely — use the person's real photo as
  // the reference. The i2v model animates it unaltered.
  if (def.redraw === null) {
    const refKey = args.sourceKeys[0];
    if (!refKey) throw new Error("gateway.stylizeCharacter: original style needs a source photo.");
    log.info("gateway.stylizeCharacter original (no stylization)", { characterId: args.characterId });
    return { refKey, styleMeta: { prompt: "original / unaltered", seed: 0, model: "none" } };
  }

  if (env.gatewayMode === "live") {
    const fal = await falClient();

    let prompt: string;
    let imageUrls: string[];
    if (args.preserveContent) {
      // Per-photo (album-to-life): FULLY redraw the target photo into the chosen
      // art style, keeping the same outfit/pose/scene (redrawn, not preserved
      // photographically), and anchor the face to the canonical photo.
      const target = await presignDownload(args.sourceKeys[0], 1800);
      imageUrls = [target];
      if (args.anchorKey && args.anchorKey !== args.sourceKeys[0]) {
        imageUrls.push(await presignDownload(args.anchorKey, 1800));
      }
      // Scene-level (NOT single-person) framing — a group photo must keep everyone.
      prompt =
        `Redraw this entire photo — every person in it AND the background — fully in the target art style. ${def.medium} ` +
        `CRITICAL: keep EVERY person who appears in the FIRST image. Do not remove, drop, omit, or merge anyone — ` +
        `preserve the exact number of people and their positions, poses, outfits, and accessories, plus the background. ` +
        `Render all of it in the art style with nothing left photographic. ` +
        (imageUrls.length > 1
          ? `For the person who matches the SECOND reference image, make their face, hairstyle, and skin tone match that reference (leave the other people as they appear in the FIRST image). `
          : "");
    } else {
      // Shared character reference (animate-me): up to 4 source photos.
      imageUrls = await Promise.all(args.sourceKeys.slice(0, 4).map((k) => presignDownload(k, 1800)));
      prompt =
        `${def.redraw} for an opening title sequence. ${def.medium} ` +
        `Keep the person's recognizable features (face shape, hairstyle, skin tone) and clothing style. ` +
        `Full upper body, iconic and consistent — this exact design (${args.label}) is reused across many shots.`;
    }

    // Style references define the look ONLY for the 'reference' style category —
    // they are NOT layered on top of pixar/anime (those are self-contained presets).
    const styleRefKeys = args.style === "reference" ? (args.styleRefKeys ?? []).slice(0, 3) : [];
    if (styleRefKeys.length) {
      const styleUrls = await Promise.all(styleRefKeys.map((k) => presignDownload(k, 1800)));
      imageUrls = [...imageUrls, ...styleUrls];
      prompt +=
        `The LAST ${styleRefKeys.length} image${styleRefKeys.length > 1 ? "s are" : " is"} STYLE reference` +
        `${styleRefKeys.length > 1 ? "s" : ""} — match their exact art style: linework, color palette, ` +
        `shading, and overall rendering. Do NOT copy their subject or composition, only their visual style.`;
    }

    const runStylize = (model: string, p: string) =>
      fal.subscribe(model, { input: imageInput(model, p, imageUrls) });

    const fallbackEndpoint = IMAGE_MODELS[FALLBACK_IMAGE_MODEL]?.endpoint ?? "fal-ai/flux-pro/kontext";

    let result;
    let usedModel = imageModel;
    try {
      result = await runStylize(imageModel, prompt);
    } catch (err) {
      const detail = describeFalError(err);
      const contentFlagged = /content checker|flagged|content policy|safety|blocked/i.test(detail);
      // Gemini-based editors (nano-banana*, gemini-flash) run a content checker
      // that refuses to restyle real photos of people. When that fires, retry on a
      // non-Gemini editor (FLUX Kontext) with the SAME prompt — it handles real
      // (adult) photos that Gemini won't. Only worth doing if we're not already on
      // a non-Gemini model.
      const alreadyNonGemini = imageModel.includes("kontext") || imageModel === fallbackEndpoint;
      if (contentFlagged && !alreadyNonGemini) {
        log.warn("gateway.stylizeCharacter content-flagged; retrying on non-Gemini fallback", {
          from: imageModel, to: fallbackEndpoint, style: args.style, perPhoto: !!args.preserveContent,
          flaggedPrompt: prompt,
        });
        try {
          result = await runStylize(fallbackEndpoint, prompt);
          usedModel = fallbackEndpoint;
        } catch (err2) {
          throw new Error(
            `stylize failed: ${imageModel} content-flagged this photo and fallback ${fallbackEndpoint} also failed — ${describeFalError(err2)}`,
          );
        }
      } else {
        log.error("gateway.stylizeCharacter rejected", {
          model: imageModel,
          style: args.style,
          perPhoto: !!args.preserveContent,
          images: imageUrls.length,
          promptChars: prompt.length,
          contentFlagged,
          detail,
        });
        throw new Error(`stylize failed on ${imageModel}: ${detail}`);
      }
    }
    const data = result.data as { images?: { url: string }[] };
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error(`gateway.stylizeCharacter: no image in ${usedModel} result.`);

    const refKey = buildKey(args.projectId, "characters", "png");
    await putObject(refKey, await fetchResult(imageUrl), "image/png");
    log.info("gateway.stylizeCharacter live ok", {
      characterId: args.characterId, style: args.style, perPhoto: !!args.preserveContent, model: usedModel,
    });
    return { refKey, styleMeta: { prompt, seed: 0, model: usedModel, style: args.style } };
  }

  // Stub: deterministic SVG reference.
  const seed = parseInt(createHash("sha1").update(args.characterId).digest("hex").slice(0, 8), 16);
  const c1 = colorFor(args.characterId);
  const c2 = colorFor(args.characterId + "2");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <circle cx="256" cy="200" r="120" fill="#ffffff" opacity="0.85"/>
  <text x="256" y="430" font-family="sans-serif" font-size="40" fill="#1a1a1a"
        text-anchor="middle">${escapeXml(args.label)}</text>
</svg>`;
  const refKey = buildKey(args.projectId, "characters", "svg");
  await putObject(refKey, Buffer.from(svg, "utf8"), "image/svg+xml");
  return { refKey, styleMeta: { prompt: `anime character ref for ${args.label}`, seed, model: "stub-image-v1" } };
}

/**
 * animate-me: place a character (from their stylized reference) into a NEW scene
 * the director described, following the user's direction. Returns a new image key
 * (the character IN the scene) for the i2v to animate. Falls back to the original
 * reference on stub mode or failure (the i2v then just animates the portrait).
 */
export async function composeCharacterInScene(args: {
  projectId: string;
  refKey: string;
  scene: string;
  label: string;
  style: OpStyle;
  imageEndpoint: string;
}): Promise<string> {
  if (env.gatewayMode !== "live") return args.refKey;
  const def = STYLE_DEF[args.style];
  try {
    const fal = await falClient();
    const url = await presignDownload(args.refKey, 1800);
    const prompt =
      `Place the person from the reference image into a brand-new scene: ${args.scene}. ` +
      `Keep their face, hairstyle, and overall design identical to the reference — the SAME character, now in ` +
      `this new setting and action. ${def.medium || "Keep it a clean, cohesive illustration."} ` +
      `A single full-frame scene featuring this character in the environment; do not add other people.`;
    const result = await fal.subscribe(args.imageEndpoint, { input: imageInput(args.imageEndpoint, prompt, [url]) });
    const outUrl = (result.data as { images?: { url: string }[] }).images?.[0]?.url;
    if (!outUrl) return args.refKey;
    const outKey = buildKey(args.projectId, "shots", "png");
    await putObject(outKey, await fetchResult(outUrl), "image/png");
    log.info("gateway.composeCharacterInScene ok", { model: args.imageEndpoint });
    return outKey;
  } catch (err) {
    log.warn("gateway.composeCharacterInScene failed; animating the reference instead", {
      detail: describeFalError(err),
    });
    return args.refKey;
  }
}

// ── shots.generate ────────────────────────────────────────────────────────────

/**
 * Per-model-family input adapter. fal endpoints share {prompt, image_url} but
 * differ on duration knobs; models generate FIXED lengths (Kling 5s/10s, Veo ~8s)
 * — assembly.compose trims each clip to its exact beat window.
 */
function i2vInput(
  endpoint: string,
  prompt: string,
  imageUrl: string,
  durationMs: number,
  aspect?: "portrait" | "landscape",
  negativePrompt?: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = { prompt, image_url: imageUrl };
  const ar = aspect === "landscape" ? "16:9" : "9:16";
  if (endpoint.includes("kling-video")) {
    base.duration = durationMs > 5_000 ? "10" : "5";
    base.aspect_ratio = ar;
    // Lower cfg_scale = more motion freedom (fights the "static frame" problem,
    // worst on flat 2D anime art). negative_prompt suppresses frozen frames.
    base.cfg_scale = 0.35;
    if (negativePrompt) base.negative_prompt = negativePrompt;
  } else if (endpoint.includes("veo")) {
    base.aspect_ratio = ar;
  }
  // Other models: default aspect; keep the input minimal and portable.
  return base;
}

/**
 * Fit a reference image into the target ASPECT frame and LETTERBOX with black bars
 * so the i2v model gets the right orientation without cropping the subject. The
 * whole subject is always visible; a mismatched-orientation source just gets black
 * bars (users avoid these by uploading photos matching the video's orientation).
 * Returns a new R2 key (or the original on any failure).
 */
async function padRefToAspect(
  projectId: string,
  srcKey: string,
  aspect: "portrait" | "landscape",
): Promise<string> {
  if (!(await ffmpegAvailable())) return srcKey;
  const { w: W, h: H } = aspectDims(aspect);
  const { dir, cleanup } = await workDir();
  try {
    const inPath = join(dir, "ref-in");
    const outPath = join(dir, "ref-pad.png");
    await writeFile(inPath, await getObject(srcKey));
    // Scale to fit inside the frame, then pad the remainder with black.
    await runFfmpeg(
      [
        "-i", inPath, "-vf",
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
        outPath,
      ],
      "pad ref to aspect",
    );
    const outKey = buildKey(projectId, "characters", "png");
    await putObject(outKey, await readFile(outPath), "image/png");
    return outKey;
  } catch (err) {
    log.warn("gateway: ref aspect-pad failed, using original", {
      err: err instanceof Error ? err.message : String(err),
    });
    return srcKey;
  } finally {
    await cleanup();
  }
}

/** Generate one shot clip from a character reference (i2v), routed per render kind. */
export async function generateShot(args: {
  projectId: string;
  characterLabel: string;
  characterId: string;
  durationMs: number;
  shotType: string;
  motion?: string;
  /** What's actually happening in the source photo — grounds the animation. */
  description?: string;
  /** False for landscape/scenery shots (no person) — animate the scene, not a subject. */
  hasCharacter?: boolean;
  refKey?: string | null;
  renderKind?: "preview" | "final";
  style: OpStyle;
  /** User-selected i2v endpoint (from projects.video_model); null = env default. */
  modelEndpoint?: string | null;
  /** Output orientation, so the model generates in the right aspect. */
  aspect?: "portrait" | "landscape";
}): Promise<ShotClipResult> {
  if (env.gatewayMode === "live") {
    if (!args.refKey) {
      throw new Error("gateway.generateShot: shot has no character reference image (refKey).");
    }
    const fal = await falClient();
    const endpoint =
      args.modelEndpoint ?? (args.renderKind === "final" ? env.i2vModelFinal : env.i2vModelPreview);
    // Frame the input to the output aspect (letterbox with black bars) so the
    // model composes in the right orientation without cropping the subject.
    const refKey = args.aspect ? await padRefToAspect(args.projectId, args.refKey, args.aspect) : args.refKey;
    const imageUrl = await presignDownload(refKey, 1800);
    // Animate FROM the photo's own context — continue the action/scene shown,
    // rather than a generic canned motion. Still emphasize movement (i2v models
    // otherwise hold the subject frozen) and keep identity, not the pose.
    const scene = args.description ? `This image shows: ${args.description}. ` : "";
    const camera = args.motion ?? "slow push-in";
    const hasCharacter = args.hasCharacter !== false; // default true (back-compat)
    let prompt: string;
    if (!hasCharacter) {
      // Landscape / establishing shot: animate the SCENE, not a subject.
      prompt =
        `Bring this still image to life as a dynamic ${args.shotType} establishing shot in an opening title ` +
        `sequence. ${scene}Animate the scene with believable ambient motion — drifting clouds, moving water, ` +
        `swaying foliage, shifting light and atmosphere — plus gentle camera movement (${camera}). ` +
        `${STYLE_DEF[args.style].motion}. Keep the composition and style consistent with the image, but it must not stay frozen.`;
    } else if (args.style === "anime") {
      // Flat 2D anime art gives i2v models few motion cues, so they hold it
      // frozen. This "sakuga" prompt (action-first, explicit camera, anime style
      // terms) is tuned to force real movement out of a cel-shaded frame.
      prompt =
        `Bring this 2D anime character to life with high-energy, sakuga-style animation for an opening title ` +
        `sequence. ${scene}The character (${args.characterLabel}) performs a dynamic motion — a confident turn, a ` +
        `hair flip, a step toward camera — expression shifting from calm to spirited. Camera: ${camera}, with ` +
        `subtle motion blur and a low dramatic angle. Cel-shaded 2D anime, thick bold outlines, saturated colors, ` +
        `rim lighting. Snappy, fluid anime motion — keep the character's identity and design consistent with the ` +
        `image, but it must absolutely not stay a static image.`;
    } else {
      prompt =
        `Bring this still image to life as a dynamic ${args.shotType} shot in an opening title sequence. ${scene}` +
        `Animate it based on what is actually happening in the image — continue the action, gesture, or moment ` +
        `shown, with believable motion: the character (${args.characterLabel}) moves naturally (body, head, ` +
        `expression), and the environment reacts (wind, hair, background, light). ` +
        `Camera: ${camera}. ${STYLE_DEF[args.style].motion}. ` +
        `Keep the character's identity and design consistent with the image, but they must not stay frozen.`;
    }

    // Framing guardrail — strong camera/subject motion can otherwise push the
    // subject out of view. Applies to character shots (scenery shots have none).
    if (hasCharacter) {
      prompt +=
        " Keep the character fully within the frame at all times — the camera movement and action must not crop the" +
        " subject out or push them off-screen.";
    }

    // Suppress frozen frames for every style; additionally suppress realism for
    // the illustrated styles (anime/fantasy), which Kling otherwise drifts back
    // toward a photo.
    const NEG_BASE =
      "static, still image, frozen, motionless, slideshow, no motion, blurry, morphing, flicker, distorted face, deformed hands, extra limbs";
    let negativePrompt = NEG_BASE;
    if (args.style === "anime" || args.style === "fantasy") {
      // Illustrated styles: keep Kling from drifting back toward a photo.
      negativePrompt += ", photorealistic, 3d render, realistic skin, photographic texture";
    } else if (args.style === "pixar") {
      // 3D cartoon: suppress the shiny "made of plastic" toy look.
      negativePrompt += ", plastic skin, glossy skin, shiny skin, wet look, waxy, rubbery, vinyl toy, hard plastic";
    }

    let result;
    try {
      result = await fal.subscribe(endpoint, {
        input: i2vInput(endpoint, prompt, imageUrl, args.durationMs, args.aspect, negativePrompt),
      });
    } catch (err) {
      log.error("gateway.generateShot rejected", {
        endpoint,
        style: args.style,
        detail: describeFalError(err),
      });
      throw new Error(`generateShot failed on ${endpoint}: ${describeFalError(err)}`);
    }
    const data = result.data as { video?: { url: string } };
    const videoUrl = data.video?.url;
    if (!videoUrl) throw new Error(`gateway.generateShot: no video in ${endpoint} result.`);

    const clipKey = buildKey(args.projectId, "shots", "mp4");
    await putObject(clipKey, await fetchResult(videoUrl), "video/mp4");
    log.info("gateway.generateShot live ok", { endpoint, shotType: args.shotType, durationMs: args.durationMs });
    return { clipKey };
  }

  // Stub: colored ffmpeg clip of the exact requested duration.
  const clipKey = buildKey(args.projectId, "shots", "mp4");
  const seconds = Math.max(0.5, args.durationMs / 1000);
  const color = colorFor(args.characterId).replace("#", "0x");

  if (await ffmpegAvailable()) {
    const { dir, cleanup } = await workDir();
    try {
      const out = join(dir, "clip.mp4");
      const label = args.characterLabel.replace(/[:\\']/g, " ");
      await runFfmpeg([
        "-f", "lavfi",
        "-i", `color=c=${color}:s=640x360:d=${seconds.toFixed(2)}:r=24`,
        "-vf",
        `drawtext=text='${label} (${args.shotType})':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2`,
        "-pix_fmt", "yuv420p",
        out,
      ]);
      await putObject(clipKey, await readFile(out), "video/mp4");
    } finally {
      await cleanup();
    }
  } else {
    // No ffmpeg: store a tiny placeholder so the spine still completes.
    await putObject(
      clipKey,
      Buffer.from(`STUB-CLIP ${args.characterLabel} ${seconds.toFixed(2)}s`, "utf8"),
      "application/octet-stream",
    );
  }
  return { clipKey };
}

export { getObject };

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

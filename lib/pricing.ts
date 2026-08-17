/**
 * Rough pre-generation COST estimate (USD). The dominant cost is image→video:
 * fal i2v models bill per second of generated clip, and a premium model (Veo)
 * is ~10–15× a cheap one (Kling Standard). This module is pure math — the caller
 * (projectStatus) resolves model endpoints and supplies counts.
 *
 * These are ballpark rates, not billed prices — enough to compare models and
 * avoid a surprise. Real cost varies with clip length, retries, and provider
 * price changes. Keep the rates in one place so they're easy to tune.
 */

// Approximate fal.ai rates.
const VIDEO_USD_PER_SEC: { match: (e: string) => boolean; rate: number; premium: boolean }[] = [
  { match: (e) => e.includes("veo"), rate: 0.75, premium: true },
  { match: (e) => e.includes("kling") && (e.includes("v3") || e.includes("pro")), rate: 0.28, premium: true },
  { match: (e) => e.includes("kling"), rate: 0.05, premium: false }, // Kling Standard
];
const VIDEO_USD_PER_SEC_DEFAULT = 0.12;

const IMAGE_USD_PER_IMAGE: { match: (e: string) => boolean; rate: number }[] = [
  { match: (e) => e.includes("nano-banana-pro"), rate: 0.10 },
  { match: (e) => e.includes("nano-banana"), rate: 0.02 },
  { match: (e) => e.includes("gemini"), rate: 0.03 },
  { match: (e) => e.includes("kontext"), rate: 0.04 },
];
const IMAGE_USD_PER_IMAGE_DEFAULT = 0.04;

// i2v models bill a MINIMUM clip length even when the cut is shorter — this is
// why many short shots cost more than a few long ones.
const MIN_CLIP_SEC = 5;
// Roughly fixed Claude cost for album analysis + storyboard.
const VISION_USD = 0.75;

function videoRate(endpoint: string): { rate: number; premium: boolean } {
  const e = endpoint.toLowerCase();
  const hit = VIDEO_USD_PER_SEC.find((r) => r.match(e));
  return hit ? { rate: hit.rate, premium: hit.premium } : { rate: VIDEO_USD_PER_SEC_DEFAULT, premium: false };
}
function imageRate(endpoint: string): number {
  const e = endpoint.toLowerCase();
  return IMAGE_USD_PER_IMAGE.find((r) => r.match(e))?.rate ?? IMAGE_USD_PER_IMAGE_DEFAULT;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * TOKEN PRICING — **1 token = $1 USD**.
 *
 * Tokens are computed from the SAME cost model as the estimate, so the price
 * scales with what actually drives spend: photo count (shots + stylizations),
 * OP length (billed video seconds), and the chosen video/image models. A flat
 * per-model price can't work — a 30-photo/120s job costs us ~5x a 5-photo/30s
 * job on the same model.
 *
 *   tokens = ceil(estimated model cost x TOKEN_MARKUP)
 *
 * The markup is the margin dial — it covers everything the raw model cost
 * doesn't: shot retries we eat, ffmpeg/worker compute, storage + egress, Stripe
 * fees (~3% + $0.30), and profit.
 *
 * It's TIER-DEPENDENT. Premium models (Kling v3 Pro, Veo) are high-cost, so 1.75x
 * already leaves healthy absolute margin. The cheap Kling 2.1 tier is so low-cost
 * that 1.75x can't clear the fixed-ish costs (free-preview subsidy + Stripe's
 * $0.30), so it gets a higher multiplier.
 *
 * ⚠ Two things this DOESN'T fully price in: (1) the per-unit rates above are
 * estimates — validate them against real fal invoices; (2) the free-preview
 * subsidy (PREVIEW_LIMIT renders/user at real cost, no revenue if they don't
 * convert) is a funnel cost no per-final multiplier fully covers at low
 * conversion.
 */
const TOKEN_MARKUP_PREMIUM = 1.75; // Kling v3 Pro, Veo (and any high-cost model)
const TOKEN_MARKUP_CHEAP = 2.5; // Kling 2.1 Standard (cheap tier needs more headroom)

/**
 * Tokens charged for a FINAL render of this configuration. This is the single
 * source of truth: the number quoted in the UI, checked at submit, and charged
 * at encode.final all come from here, so they can never disagree.
 *
 * `videoEndpoint` must be the FINAL route (not the cheap preview route).
 */
export function finalTokenCost(params: {
  mode: string;
  imageEndpoint: string;
  videoEndpoint: string;
  photoCount: number;
  characterCount: number;
  opLengthMs: number;
}): number {
  const est = estimateCost({ ...params, renderKind: "final" });
  // Premium video tiers use the lower multiplier; the cheap tier (not premium)
  // uses the higher one so small jobs still clear fixed costs.
  const markup = est.premiumVideo ? TOKEN_MARKUP_PREMIUM : TOKEN_MARKUP_CHEAP;
  return Math.max(1, Math.ceil(est.low * markup));
}

/**
 * How many shots animate-me generates for an OP of this length — ~1 shot per 5s,
 * floored at 6, capped at 24. THE single source of truth: both the price estimate
 * and the director (director.storyboard) use it, so the charge equals what's made.
 */
export function animateMeShotCount(opLengthMs: number): number {
  const opSec = Math.max(1, opLengthMs / 1000);
  return Math.min(24, Math.max(6, Math.round(opSec / 5)));
}

export interface CostEstimate {
  currency: "USD";
  low: number;
  high: number;
  shots: number;
  stylizations: number;
  videoSeconds: number;
  premiumVideo: boolean;
  breakdown: { label: string; cost: number }[];
  note?: string;
}

export function estimateCost(params: {
  mode: string;
  renderKind: "preview" | "final";
  imageEndpoint: string;
  videoEndpoint: string;
  photoCount: number;
  characterCount: number;
  opLengthMs: number;
}): CostEstimate {
  const opSec = Math.max(1, params.opLengthMs / 1000);

  // Shot + stylization counts per mode.
  let shots: number;
  let stylizations: number;
  if (params.mode === "album-to-life") {
    shots = Math.max(1, params.photoCount); // one shot per photo
    stylizations = Math.max(1, params.photoCount); // every photo is stylized
  } else {
    // animate-me: the director plans EXACTLY this many shots (no reuse), each a
    // new scene composed for a character — so one image compose + one clip per
    // shot. The estimate and the director share animateMeShotCount, so the quote
    // equals what's actually generated.
    shots = animateMeShotCount(params.opLengthMs);
    stylizations = shots; // per-shot scene composition (character → new scene)
  }

  // Billed video seconds: each shot bills at least MIN_CLIP_SEC.
  const sliceSec = opSec / shots;
  const videoSeconds = Math.round(shots * Math.max(MIN_CLIP_SEC, sliceSec));

  const { rate: vRate, premium } = videoRate(params.videoEndpoint);
  const iRate = imageRate(params.imageEndpoint);

  const videoCost = videoSeconds * vRate;
  const imageCost = stylizations * iRate;
  const base = videoCost + imageCost + VISION_USD;

  let note: string | undefined;
  if (premium && params.renderKind === "preview") {
    note =
      "This preview is running on a premium video model. Switch the video model to Kling 2.1 Standard " +
      "(Advanced → AI models) to cut cost ~10×.";
  }

  return {
    currency: "USD",
    low: round2(base),
    high: round2(base * 1.4), // headroom for clip-length variance + shot retries
    shots,
    stylizations,
    videoSeconds,
    premiumVideo: premium,
    breakdown: [
      { label: `Video — ${shots} shots ≈ ${videoSeconds}s @ $${vRate}/s`, cost: round2(videoCost) },
      { label: `Stylize — ${stylizations} image(s) @ $${iRate}`, cost: round2(imageCost) },
      { label: "Vision — analysis + storyboard", cost: VISION_USD },
    ],
    note,
  };
}

/**
 * Central, typed access to environment configuration. Both `web` and `worker`
 * import from here. Datastore URLs come from Railway reference variables in
 * production (never hardcoded); see docs/railway-deployment-topology.md.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Per-model live/stub override; falls back to the global MODELS_MODE. */
function modeOverride(name: string): "live" | "stub" {
  const v = process.env[name] ?? process.env.MODELS_MODE ?? "stub";
  return v === "live" ? "live" : "stub";
}

export const env = {
  // datastores
  databaseUrl: optional("DATABASE_URL"),
  redisUrl: optional("REDIS_URL", "redis://localhost:6379"),

  // app
  appUrl: optional("APP_URL", "http://localhost:3000"),
  nodeEnv: optional("NODE_ENV", "development"),
  // Public base URL for PERSISTENT gallery/marketing assets — a SEPARATE public
  // R2 bucket with NO TTL (see docs/gallery-assets.md). e.g. https://cdn.opmylife.com.
  // Empty → the gallery shows gradient placeholders instead of videos.
  galleryAssetBaseUrl: optional("GALLERY_ASSET_BASE_URL"),
  // The gallery bucket NAME — when set, the gallery lists it and derives titles
  // from filenames (drop a video in → it appears). Empty → the code fallback list.
  galleryBucket: optional("GALLERY_BUCKET"),

  // billing / pipeline knobs (Phase 1 stubs)
  startingCreditGrant: int("STARTING_CREDIT_GRANT", 0), // 1 token = $1; no free grant
  finalEncodeCost: int("FINAL_ENCODE_COST", 10),
  renderTtlHours: int("RENDER_TTL_HOURS", 72),
  shotMaxAttempts: int("SHOT_MAX_ATTEMPTS", 2),
  // Abuse / cost controls. Previews are FREE to the user but cost us real model
  // spend, so cap them per user (LIFETIME total); and cap concurrent renders.
  previewLimit: int("PREVIEW_LIMIT", 3),
  maxConcurrentRenders: int("MAX_CONCURRENT_RENDERS", 2),
  // Generous album cap (the 3-cap is only for style references, not the album).
  maxPhotosPerProject: int("MAX_PHOTOS_PER_PROJECT", 30),
  opLengthMs: int("OP_LENGTH_MS", 15_000),

  // R2
  r2: {
    accountId: optional("R2_ACCOUNT_ID"),
    accessKeyId: optional("R2_ACCESS_KEY_ID"),
    secretAccessKey: optional("R2_SECRET_ACCESS_KEY"),
    bucket: optional("R2_BUCKET", "anime-op-dev"),
    publicBaseUrl: optional("R2_PUBLIC_BASE_URL"),
  },

  // auth
  clerk: {
    publishableKey: optional("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    secretKey: optional("CLERK_SECRET_KEY"),
    configured: !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },

  // models
  modelsMode: (optional("MODELS_MODE", "stub") === "live" ? "live" : "stub") as "live" | "stub",
  // Per-model overrides so integrations can go live one at a time
  // (e.g. VISION_MODE=live while gateway/music stay stubbed).
  visionMode: modeOverride("VISION_MODE"),
  gatewayMode: modeOverride("GATEWAY_MODE"),
  musicMode: modeOverride("MUSIC_MODE"),
  modelGatewayKey: optional("MODEL_GATEWAY_KEY"),
  // fal.ai model routes. Any fal-hosted model works here — set I2V_MODEL_FINAL
  // to a Veo endpoint (e.g. fal-ai/veo3.1/image-to-video) to render finals on
  // Google's video model; previews stay on a cheap route.
  imageModel: optional("IMAGE_MODEL", "fal-ai/nano-banana-pro/edit"),
  i2vModelPreview: optional("I2V_MODEL_PREVIEW", "fal-ai/kling-video/v2.1/standard/image-to-video"),
  i2vModelFinal: optional("I2V_MODEL_FINAL", "fal-ai/kling-video/v3/pro/image-to-video"),
  visionLlmKey: optional("VISION_LLM_KEY"),
  visionLlmModel: optional("VISION_LLM_MODEL", "claude-opus-4-8"),
  musicApiKey: optional("MUSIC_API_KEY"),

  // stripe (Phase 2)
  stripe: {
    secretKey: optional("STRIPE_SECRET_KEY"),
    webhookSecret: optional("STRIPE_WEBHOOK_SECRET"),
    configured: !!process.env.STRIPE_SECRET_KEY,
  },

  // CSAM scanning + NCMEC reporting. See lib/safety.
  //   SAFETY_SCAN_MODE: off | monitor | enforce
  //     off     — no scanning (dev / not yet wired)
  //     monitor — scan + record flags, but DON'T block (for tuning a new provider)
  //     enforce — scan + BLOCK + quarantine + legal-hold any flagged upload
  //   SAFETY_PROVIDER: the detector to call (e.g. "moderation-api"); empty = none.
  //   SAFETY_API_URL / SAFETY_API_KEY: your detector endpoint (PhotoDNA proxy,
  //     Thorn Safer, Hive, or your own microservice) — see lib/safety.
  //   SAFETY_ALERT_WEBHOOK: optional URL pinged on every flag (operator alert).
  safety: {
    mode: ((): "off" | "monitor" | "enforce" => {
      const v = optional("SAFETY_SCAN_MODE", "off");
      return v === "enforce" || v === "monitor" ? v : "off";
    })(),
    provider: optional("SAFETY_PROVIDER"),
    apiUrl: optional("SAFETY_API_URL"),
    apiKey: optional("SAFETY_API_KEY"),
    alertWebhook: optional("SAFETY_ALERT_WEBHOOK"),
    // NCMEC CyberTipline — registered-ESP credentials. Reporting stays
    // operator-triggered; these only enable the report client.
    ncmec: {
      apiUrl: optional("NCMEC_API_URL"),
      username: optional("NCMEC_USERNAME"),
      password: optional("NCMEC_PASSWORD"),
      configured: !!process.env.NCMEC_API_URL && !!process.env.NCMEC_USERNAME,
    },
  },
} as const;

export function requireEnv(name: string): string {
  return required(name);
}

/** True when R2 credentials are present; storage falls back to a clear error otherwise. */
export const r2Configured = !!(env.r2.accountId && env.r2.accessKeyId && env.r2.secretAccessKey);

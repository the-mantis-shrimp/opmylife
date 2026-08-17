/**
 * CSAM scanning gate. Runs at ingest, BEFORE any uploaded image is forwarded to a
 * model API (fal / Anthropic) — you must never transmit suspected CSAM onward.
 *
 * ⚠️ THIS MODULE DOES NOT DETECT CSAM ON ITS OWN. Real detection is hash-matching
 * against NCMEC's hash set via an approved provider — Microsoft PhotoDNA (free,
 * requires approval), Thorn Safer (paid), or Cloudflare's CSAM Scanning Tool. This
 * file is the pluggable GATE + adapter interface; you supply the detector endpoint
 * (SAFETY_API_URL) which it POSTs each image to. A homemade classifier is NOT
 * compliant.
 *
 * Modes (SAFETY_SCAN_MODE): off | monitor | enforce.
 */
import { env } from "../env";
import { log } from "../logger";

export interface ScanVerdict {
  /** True → treat as apparent CSAM: block, quarantine, legal-hold, alert. */
  flagged: boolean;
  provider: string;
  /** Optional confidence/severity from the provider. */
  score?: number;
  /** True when the provider matched a KNOWN hash (vs a classifier guess). */
  knownMatch?: boolean;
  /** Raw provider payload, stored on the flag for the operator/NCMEC report. */
  detail?: unknown;
}

/** A detector: given image bytes, return a verdict. */
type Detector = (bytes: Buffer, mime: string) => Promise<ScanVerdict>;

/**
 * Generic HTTP detector: POST the image to your configured endpoint and read back
 * `{ flagged: boolean, score?, knownMatch? }`. Point SAFETY_API_URL at a PhotoDNA
 * proxy, Thorn Safer, Hive, or your own microservice. Keeping the provider behind
 * an HTTP boundary means the hash/match logic (and the sensitive hash set) never
 * live in this app.
 */
const moderationApiDetector: Detector = async (bytes, mime) => {
  if (!env.safety.apiUrl) {
    throw new Error("SAFETY_API_URL is not set — cannot scan in a non-off mode.");
  }
  const res = await fetch(env.safety.apiUrl, {
    method: "POST",
    headers: {
      "content-type": mime || "application/octet-stream",
      ...(env.safety.apiKey ? { authorization: `Bearer ${env.safety.apiKey}` } : {}),
    },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`safety detector returned ${res.status}`);
  const data = (await res.json()) as { flagged?: boolean; score?: number; knownMatch?: boolean };
  return {
    flagged: data.flagged === true,
    provider: env.safety.provider || "moderation-api",
    score: data.score,
    knownMatch: data.knownMatch,
    detail: data,
  };
};

function detector(): Detector {
  // Only one adapter shipped; add PhotoDNA/Safer-specific adapters here as needed.
  switch (env.safety.provider) {
    case "":
      throw new Error("SAFETY_PROVIDER is not set — configure a detector before enabling scanning.");
    default:
      return moderationApiDetector;
  }
}

/**
 * Scan one image. In `off` mode returns a clear verdict without calling anything.
 *
 * FAIL-CLOSED: in monitor/enforce mode, a scanner error THROWS — the caller must
 * treat "couldn't scan" as "don't proceed", so unscanned content never reaches a
 * model API. (The ingest gate turns a throw into a held/blocked project.)
 */
export async function scanImage(bytes: Buffer, mime: string): Promise<ScanVerdict> {
  if (env.safety.mode === "off") {
    return { flagged: false, provider: "disabled" };
  }
  return detector()(bytes, mime);
}

export const scanEnabled = env.safety.mode !== "off";
export const scanEnforcing = env.safety.mode === "enforce";

/** Best-effort operator alert on a flag (never throws — alerting must not block). */
export async function alertOperator(payload: Record<string, unknown>): Promise<void> {
  log.error("SAFETY FLAG — apparent CSAM detected", payload); // always logged
  if (!env.safety.alertWebhook) return;
  try {
    await fetch(env.safety.alertWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    log.error("safety alert webhook failed", { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * R2 credential diagnostic. Tests the EXACT path the app uses (same SDK + config
 * as lib/storage) so you can validate R2 creds without redeploying.
 *
 *   npm run r2:check
 *
 * Reads R2_* from .env.local (or the shell env). Attempts a small PutObject and
 * prints success or the precise error code:
 *   InvalidAccessKeyId   → R2_ACCESS_KEY_ID is wrong/old
 *   SignatureDoesNotMatch / AccessDenied → secret wrong, mismatched with the key,
 *       wrong field (Token value vs Secret Access Key), or whitespace
 *   (success)            → credentials + bucket write permission are good
 */
import "../lib/loadenv";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../lib/env";

function show(v: string) {
  if (!v) return "(empty)";
  return `${v.slice(0, 4)}…${v.slice(-2)} (len ${v.length})`;
}

async function main() {
  console.log("R2 config seen by the app:");
  console.log("  R2_ACCOUNT_ID       :", env.r2.accountId || "(empty)");
  console.log("  R2_BUCKET           :", env.r2.bucket || "(empty)");
  console.log("  R2_ACCESS_KEY_ID    :", show(env.r2.accessKeyId));
  console.log("  R2_SECRET_ACCESS_KEY:", show(env.r2.secretAccessKey));

  // Catch the classic copy/paste mistakes early.
  if (/\s/.test(env.r2.accessKeyId) || /\s/.test(env.r2.secretAccessKey)) {
    console.warn("  ⚠ A credential contains whitespace — likely a stray space/newline from pasting.");
  }
  if (env.r2.accessKeyId && env.r2.accessKeyId.length !== 32) {
    console.warn(`  ⚠ Access Key ID is ${env.r2.accessKeyId.length} chars; R2 keys are usually 32 hex chars.`);
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.r2.accessKeyId, secretAccessKey: env.r2.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  const key = `_diag/r2-check-${Date.now()}.txt`;
  try {
    await s3.send(new PutObjectCommand({ Bucket: env.r2.bucket, Key: key, Body: "ok", ContentType: "text/plain" }));
    console.log(`\n✓ PutObject succeeded (${key}). Credentials + bucket write permission are correct.`);
  } catch (err: any) {
    console.error("\n✗ PutObject failed.");
    console.error("  code   :", err?.name ?? err?.Code ?? "unknown");
    console.error("  status :", err?.$metadata?.httpStatusCode ?? "?");
    console.error("  message:", err?.message ?? String(err));
  }
}

main();

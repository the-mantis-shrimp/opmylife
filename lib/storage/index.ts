/**
 * Object storage. Production = Cloudflare R2 (presigned browser uploads + native
 * lifecycle TTL deletion; see docs/railway-deployment-topology.md). For local dev
 * without R2 creds we fall back to a filesystem driver served by two API routes,
 * so the full pipeline is runnable offline.
 *
 * R2 is the one deliberately non-Railway piece: we need (a) direct browser→storage
 * presigned PUTs and (b) lifecycle rules that auto-delete inputs/outputs after the
 * TTL window. The cleanup.ttl stage and the bucket lifecycle rule both back the
 * privacy promise — deletion is server-side, never tied to browser close.
 */
import { randomUUID } from "node:crypto";
import { env, r2Configured } from "../env";

export type StorageDriver = "r2" | "local";
export const driver: StorageDriver = r2Configured ? "r2" : "local";

/** Build a namespaced R2 key. Grouping by project lets cleanup.ttl delete a prefix. */
export function buildKey(projectId: string, kind: string, ext: string): string {
  return `projects/${projectId}/${kind}/${randomUUID()}.${ext.replace(/^\./, "")}`;
}

// ── R2 (S3-compatible) ──────────────────────────────────────────────────────
let _s3: import("@aws-sdk/client-s3").S3Client | null = null;
async function s3() {
  if (_s3) return _s3;
  const { S3Client } = await import("@aws-sdk/client-s3");
  _s3 = new S3Client({
    region: "auto",
    endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.r2.accessKeyId,
      secretAccessKey: env.r2.secretAccessKey,
    },
    // Recent AWS SDK versions inject a CRC32 integrity checksum by default
    // (x-amz-sdk-checksum-algorithm / x-amz-checksum-crc32). That breaks
    // presigned PUTs to R2 (Cloudflare doesn't accept the placeholder checksum),
    // so restrict checksums to operations that strictly require them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return _s3;
}

// ── Local filesystem fallback ────────────────────────────────────────────────
async function localPath(key: string) {
  const { join } = await import("node:path");
  const root = join(process.cwd(), ".tmp", "storage");
  return { root, full: join(root, key) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Presigned URL the BROWSER uses to PUT a file directly to storage. */
export async function presignUpload(
  key: string,
  contentType: string,
  expiresIn = 600,
): Promise<string> {
  if (driver === "r2") {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const cmd = new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(await s3(), cmd, { expiresIn });
  }
  // Local: PUT to our own route which writes to .tmp/storage.
  return `${env.appUrl}/api/local-storage/${encodeURI(key)}`;
}

/**
 * URL to read/download an object (presigned GET on R2, route on local).
 *
 * Pass `downloadName` to force a SAVE (Content-Disposition: attachment) with that
 * filename — needed because the browser's `<a download>` attribute is ignored for
 * cross-origin URLs (our R2 host differs from the app origin), so a plain link
 * just navigates to/opens the video. This makes the download actually download.
 */
export async function presignDownload(key: string, expiresIn = 3600, downloadName?: string): Promise<string> {
  if (driver === "r2") {
    // A public base URL can't carry a per-request Content-Disposition, so when a
    // forced download is requested we must sign the request instead.
    if (env.r2.publicBaseUrl && !downloadName) return `${env.r2.publicBaseUrl}/${key}`;
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const cmd = new GetObjectCommand({
      Bucket: env.r2.bucket,
      Key: key,
      ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` } : {}),
    });
    return getSignedUrl(await s3(), cmd, { expiresIn });
  }
  // Local dev is same-origin, so the `<a download>` attribute works there.
  return `${env.appUrl}/api/local-storage/${encodeURI(key)}`;
}

/** Server-side write (used by the worker to store generated artifacts). */
export async function putObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
  if (driver === "r2") {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await s3()).send(
      new PutObjectCommand({ Bucket: env.r2.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return;
  }
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { full } = await localPath(key);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body);
}

/** Server-side read. */
export async function getObject(key: string): Promise<Buffer> {
  if (driver === "r2") {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await s3()).send(new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }));
    const chunks: Buffer[] = [];
    // @ts-expect-error Node stream
    for await (const chunk of res.Body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  const { readFile } = await import("node:fs/promises");
  const { full } = await localPath(key);
  return readFile(full);
}

/**
 * Does an object exist? A cheap HEAD (no body transfer). Used to catch phantom
 * asset rows — uploads whose presigned PUT never completed, so the DB row exists
 * but the object doesn't (which would otherwise crash a later getObject).
 */
export async function objectExists(key: string): Promise<boolean> {
  if (driver === "r2") {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      await (await s3()).send(new HeadObjectCommand({ Bucket: env.r2.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  const { access } = await import("node:fs/promises");
  const { full } = await localPath(key);
  return access(full).then(() => true).catch(() => false);
}

/** List all object keys in a bucket (used to discover gallery demo videos). */
export async function listBucketKeys(bucket: string): Promise<string[]> {
  if (driver !== "r2") return [];
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const list = await (await s3()).send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of list.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Server-side copy within the bucket (used to snapshot renders into history). */
export async function copyObject(srcKey: string, destKey: string): Promise<void> {
  if (driver === "r2") {
    const { CopyObjectCommand } = await import("@aws-sdk/client-s3");
    await (await s3()).send(
      new CopyObjectCommand({ Bucket: env.r2.bucket, CopySource: `${env.r2.bucket}/${encodeURI(srcKey)}`, Key: destKey }),
    );
    return;
  }
  const { mkdir, copyFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const src = await localPath(srcKey);
  const dest = await localPath(destKey);
  await mkdir(dirname(dest.full), { recursive: true });
  await copyFile(src.full, dest.full);
}

/** Delete a single object by key (used when a user removes an uploaded photo). */
export async function deleteObject(key: string): Promise<void> {
  if (driver === "r2") {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await s3()).send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key }));
    return;
  }
  const { rm } = await import("node:fs/promises");
  const { full } = await localPath(key);
  await rm(full, { force: true }).catch(() => {});
}

/**
 * Delete every object under a project's prefix. Used by cleanup.ttl as a
 * belt-and-braces complement to the R2 lifecycle rule (server-side deletion).
 */
export async function deleteProjectPrefix(projectId: string): Promise<number> {
  const prefix = `projects/${projectId}/`;
  if (driver === "r2") {
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    let deleted = 0;
    let token: string | undefined;
    do {
      const list = await (await s3()).send(
        new ListObjectsV2Command({ Bucket: env.r2.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (objects.length) {
        await (await s3()).send(
          new DeleteObjectsCommand({ Bucket: env.r2.bucket, Delete: { Objects: objects } }),
        );
        deleted += objects.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { root } = await localPath("");
  try {
    await rm(join(root, "projects", projectId), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  return 0;
}

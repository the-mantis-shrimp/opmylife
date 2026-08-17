/**
 * Local storage driver endpoint — ONLY active when R2 is not configured (dev).
 * Stands in for R2's presigned PUT and object GET so the browser-upload and
 * download flows work offline. In production R2 serves these directly and this
 * route is never hit. See lib/storage.
 */
import { NextResponse } from "next/server";
import { driver, putObject, getObject } from "../../../../lib/storage";

export const dynamic = "force-dynamic";

function keyFrom(params: { key: string[] }): string {
  return params.key.map((p) => decodeURIComponent(p)).join("/");
}

export async function PUT(req: Request, { params }: { params: { key: string[] } }) {
  if (driver !== "local") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const key = keyFrom(params);
  const buf = Buffer.from(await req.arrayBuffer());
  const contentType = req.headers.get("content-type") || "application/octet-stream";
  await putObject(key, buf, contentType);
  return NextResponse.json({ ok: true, key });
}

export async function GET(_req: Request, { params }: { params: { key: string[] } }) {
  if (driver !== "local") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const key = keyFrom(params);
  try {
    const buf = await getObject(key);
    const type = key.endsWith(".mp4")
      ? "video/mp4"
      : key.endsWith(".svg")
        ? "image/svg+xml"
        : key.endsWith(".m4a")
          ? "audio/mp4"
          : "application/octet-stream";
    return new NextResponse(new Uint8Array(buf), { headers: { "content-type": type } });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

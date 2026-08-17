/**
 * GET /api/health — liveness + dependency check for Railway's health probe.
 * Returns 200 only when Postgres and Redis are reachable.
 */
import { NextResponse } from "next/server";
import { queryOne } from "../../../lib/db";
import { connection } from "../../../lib/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    await queryOne("SELECT 1 AS ok");
    checks.postgres = "ok";
  } catch (e) {
    checks.postgres = e instanceof Error ? e.message : "error";
    healthy = false;
  }

  try {
    const pong = await connection().ping();
    checks.redis = pong === "PONG" ? "ok" : pong;
  } catch (e) {
    checks.redis = e instanceof Error ? e.message : "error";
    healthy = false;
  }

  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks, time: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}

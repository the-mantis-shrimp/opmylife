/** Small helpers for route handlers. Routes stay THIN: validate, write a row,
 *  enqueue, return fast. No heavy work in API routes (docs/architecture.md). */
import { NextResponse } from "next/server";
import { UnauthorizedError } from "./auth";

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Wrap a handler to translate auth errors and surface failures as JSON. */
export async function guard<T>(fn: () => Promise<T>): Promise<T | NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnauthorizedError) return bad("Unauthorized", 401);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

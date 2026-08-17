/**
 * Credit billing. The defining rule: CREDITS ARE CHARGED ONLY ON FINAL ENCODE.
 * Balance = sum(credit_ledger.delta) — never a mutable column. Previews are free
 * and write NO ledger entry.
 *
 * Phase 1: no real money. Each user gets a stub `grant`; charge_final decrements
 * it so the charge POINT is exercised before Stripe is attached. Stripe purchase
 * rows arrive in Phase 2.
 */
import type { PoolClient } from "pg";
import { query, queryOne, tx } from "../db";
import { env } from "../env";

export type LedgerReason = "grant" | "purchase" | "charge_final" | "refund" | "adjust";

/**
 * Tokens are bought à la carte: **1 token = $1 USD**, any whole quantity from 1
 * up to MAX_TOKEN_PURCHASE. The checkout builds a one-off Stripe line item and
 * the webhook grants `credits` from the session metadata (no Stripe dashboard
 * Price objects needed).
 */
export const TOKEN_PRICE_CENTS = 100; // $1.00 per token
export const MIN_TOKEN_PURCHASE = 5; // Stripe's fixed fee makes tiny buys inefficient
export const MAX_TOKEN_PURCHASE = 500;

/** Validate a requested purchase quantity to a whole MIN..MAX. Null = invalid. */
export function normalizeTokenQuantity(n: unknown): number | null {
  const q = Math.floor(Number(n));
  if (!Number.isFinite(q) || q < MIN_TOKEN_PURCHASE || q > MAX_TOKEN_PURCHASE) return null;
  return q;
}

/**
 * Record a completed credit PURCHASE (positive delta). Idempotent on `stripeRef`
 * (the Stripe session/event id) so webhook retries never double-grant — backed
 * by the partial unique index on credit_ledger(stripe_ref).
 */
export async function recordPurchase(args: {
  userId: string;
  credits: number;
  stripeRef: string;
}): Promise<{ granted: boolean }> {
  const res = await query<{ id: string }>(
    `INSERT INTO credit_ledger (user_id, delta, reason, stripe_ref)
     VALUES ($1, $2, 'purchase', $3)
     ON CONFLICT (stripe_ref) WHERE stripe_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [args.userId, Math.abs(args.credits), args.stripeRef],
  );
  return { granted: res.length > 0 };
}

/** Balance = sum of all ledger deltas for the user. */
export async function balance(userId: string): Promise<number> {
  const row = await queryOne<{ bal: string | null }>(
    `SELECT COALESCE(SUM(delta), 0)::int AS bal FROM credit_ledger WHERE user_id = $1`,
    [userId],
  );
  return Number(row?.bal ?? 0);
}

/**
 * Seed the one-time starter grant for a new user. The partial unique index
 * (reason='grant') makes this idempotent — re-running never double-grants.
 */
export async function ensureStarterGrant(userId: string): Promise<void> {
  await query(
    `INSERT INTO credit_ledger (user_id, delta, reason)
     VALUES ($1, $2, 'grant')
     ON CONFLICT (user_id) WHERE reason = 'grant' DO NOTHING`,
    [userId, env.startingCreditGrant],
  );
}

/**
 * THE charge point. Called only by encode.final for a FINAL render, in one
 * transaction: verify renders.charged=false → insert charge_final (negative
 * delta) → flip renders.charged=true, watermarked=false. Idempotent: if already
 * charged, does nothing. NEVER charges previews or internal retries.
 *
 * Returns whether a charge was actually written (false = already charged).
 */
export async function chargeFinalEncode(args: {
  userId: string;
  projectId: string;
  renderId: string;
  finalKey: string;
  durationMs: number;
  cost?: number;
}): Promise<{ charged: boolean; alreadyCharged: boolean }> {
  const cost = args.cost ?? env.finalEncodeCost;
  return tx(async (client: PoolClient) => {
    // Lock the render row so concurrent encode.final attempts can't double-charge.
    const r = await client.query<{ charged: boolean }>(
      `SELECT charged FROM renders WHERE id = $1 FOR UPDATE`,
      [args.renderId],
    );
    if (r.rows.length === 0) throw new Error(`render ${args.renderId} not found`);
    if (r.rows[0].charged) {
      // Already billed — make the rest of encode.final idempotent, no new ledger row.
      return { charged: false, alreadyCharged: true };
    }

    await client.query(
      `INSERT INTO credit_ledger (user_id, project_id, delta, reason)
       VALUES ($1, $2, $3, 'charge_final')`,
      [args.userId, args.projectId, -Math.abs(cost)],
    );
    await client.query(
      `UPDATE renders
         SET charged = true, watermarked = false, r2_key = $2, duration_ms = $3
       WHERE id = $1`,
      [args.renderId, args.finalKey, args.durationMs],
    );
    return { charged: true, alreadyCharged: false };
  });
}

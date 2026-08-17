/**
 * POST /api/stripe/webhook — Stripe billing webhook. Phase 2 endpoint; wired now
 * so the URL is stable (point the Stripe dashboard at
 * https://<your-domain>/api/stripe/webhook and set STRIPE_WEBHOOK_SECRET).
 *
 * Like all API routes it stays THIN: verify signature, write a ledger row /
 * enqueue work, return fast. Phase 1 has no real payments, so when Stripe isn't
 * configured this acknowledges and no-ops. NEVER charge here — the only
 * generation charge is charge_final at encode.final.
 */
import { NextResponse } from "next/server";
import { env } from "../../../../lib/env";
import { recordPurchase } from "../../../../lib/billing";
import { log } from "../../../../lib/logger";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!env.stripe.configured || !env.stripe.webhookSecret) {
    // Phase 1: acknowledge so Stripe (if ever pointed here) doesn't retry forever.
    return NextResponse.json({ received: true, note: "stripe not configured (Phase 1)" });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const raw = await req.text();
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(env.stripe.secretKey);
    const event = stripe.webhooks.constructEvent(raw, sig, env.stripe.webhookSecret);

    // On a completed, PAID checkout → grant the purchased credits. Idempotent on
    // the session id (recordPurchase), so Stripe's at-least-once retries never
    // double-grant. We fulfill only from the webhook, never the client redirect.
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as {
        id: string;
        payment_status: string | null;
        metadata: Record<string, string> | null;
      };
      const userId = session.metadata?.userId;
      const credits = Number(session.metadata?.credits ?? "0");
      if (session.payment_status !== "paid") {
        log.info("stripe checkout not paid yet, ignoring", { id: session.id, status: session.payment_status });
      } else if (!userId || !Number.isFinite(credits) || credits <= 0) {
        log.warn("stripe checkout missing/invalid metadata", { id: session.id, userId, credits });
      } else {
        const { granted } = await recordPurchase({ userId, credits, stripeRef: session.id });
        log.info("stripe purchase recorded", { id: session.id, userId, credits, granted });
      }
    } else {
      log.info("stripe event ignored", { type: event.type });
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "webhook error";
    log.error("stripe webhook verification failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * POST /api/stripe/checkout — start a Stripe Checkout session to buy tokens at
 * $1/token. Returns { url } for the browser to redirect to. The actual token
 * grant happens in the webhook on `checkout.session.completed` (never trust the
 * client redirect for fulfillment). Thin route.
 *
 * Body: { quantity: number }  // 1..MAX_TOKEN_PURCHASE
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../lib/api";
import { currentUser } from "../../../../lib/auth";
import { TOKEN_PRICE_CENTS, MIN_TOKEN_PURCHASE, MAX_TOKEN_PURCHASE, normalizeTokenQuantity } from "../../../../lib/billing";
import { env } from "../../../../lib/env";

export const dynamic = "force-dynamic";

const Schema = z.object({ quantity: z.number() });

export async function POST(req: Request) {
  return guard(async () => {
    if (!env.stripe.configured) return bad("Billing is not configured.", 503);

    const user = await currentUser();
    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    const qty = parsed.success ? normalizeTokenQuantity(parsed.data.quantity) : null;
    if (qty === null) return bad(`Enter a whole number of tokens between ${MIN_TOKEN_PURCHASE} and ${MAX_TOKEN_PURCHASE}.`);

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(env.stripe.secretKey);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "OPmylife tokens" },
            unit_amount: TOKEN_PRICE_CENTS, // $1 per token
          },
          quantity: qty, // Stripe multiplies unit_amount × quantity for the total
        },
      ],
      // The webhook reads these to grant tokens to the right user.
      client_reference_id: user.id,
      metadata: { userId: user.id, credits: String(qty) },
      success_url: `${env.appUrl}/dashboard?purchase=success`,
      cancel_url: `${env.appUrl}/dashboard?purchase=cancel`,
    });

    return ok({ url: session.url });
  });
}

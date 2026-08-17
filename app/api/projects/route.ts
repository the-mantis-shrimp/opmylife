/**
 * /api/projects
 *   GET  — list the signed-in user's projects (+ credit balance).
 *   POST — create a project with a title. Thin: writes a row, returns fast.
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../lib/api";
import { currentUser } from "../../../lib/auth";
import { query, queryOne } from "../../../lib/db";
import { balance, MIN_TOKEN_PURCHASE, MAX_TOKEN_PURCHASE } from "../../../lib/billing";
import { ASPECT_RATIOS } from "../../../lib/projects";
import { env } from "../../../lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const user = await currentUser();
    const projects = await query(
      `SELECT id, title, status, identity_path, music_source, created_at, expires_at
         FROM projects WHERE user_id = $1 ORDER BY created_at DESC`,
      [user.id],
    );
    return ok({
      projects,
      credits: await balance(user.id),
      billingEnabled: env.stripe.configured,
      minTokenPurchase: MIN_TOKEN_PURCHASE,
      maxTokenPurchase: MAX_TOKEN_PURCHASE,
    });
  });
}

const CreateSchema = z.object({
  title: z.string().min(1).max(120),
  aspectRatio: z.enum(ASPECT_RATIOS as [string, ...string[]]).default("portrait"),
});

export async function POST(req: Request) {
  return guard(async () => {
    const user = await currentUser();
    const body = await req.json().catch(() => ({}));
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return bad("title is required (1–120 chars)");

    const project = await queryOne(
      `INSERT INTO projects (user_id, title, status, aspect_ratio) VALUES ($1, $2, 'draft', $3)
       RETURNING id, title, status, created_at`,
      [user.id, parsed.data.title, parsed.data.aspectRatio],
    );
    return ok({ project }, { status: 201 });
  });
}

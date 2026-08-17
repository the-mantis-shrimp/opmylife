/**
 * POST /api/projects/:id/consent — the consent step. The biometric checkbox is a
 * DISTINCT decision from ToS (separate fields here, separate rows in the DB).
 * Writes versioned, append-only `consents` rows and resolves identity_path:
 * granted → 'cluster' (face clustering), declined → 'manual' (tagging fallback).
 * See docs/privacy-and-consent.md.
 *
 * Body: { tosAccepted: boolean, biometricGranted: boolean }
 */
import { z } from "zod";
import { ok, bad, guard } from "../../../../../lib/api";
import { currentUser } from "../../../../../lib/auth";
import { getOwnedProject } from "../../../../../lib/projects";
import { recordConsent } from "../../../../../lib/consent";
import { query } from "../../../../../lib/db";

export const dynamic = "force-dynamic";

const Schema = z.object({
  tosAccepted: z.boolean(),
  biometricGranted: z.boolean(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return guard(async () => {
    const user = await currentUser();
    const project = await getOwnedProject(params.id, user.id);
    if (!project) return bad("Project not found", 404);

    const parsed = Schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("tosAccepted and biometricGranted are required booleans");
    const { tosAccepted, biometricGranted } = parsed.data;

    if (!tosAccepted) return bad("You must accept the Terms of Service to continue.");

    // Two distinct decisions → two distinct rows. Never bundled.
    await recordConsent({ projectId: project.id, userId: user.id, kind: "tos", granted: true });
    await recordConsent({ projectId: project.id, userId: user.id, kind: "biometric", granted: biometricGranted });

    const identityPath = biometricGranted ? "cluster" : "manual";
    await query(`UPDATE projects SET identity_path = $2, updated_at = now() WHERE id = $1`, [
      project.id,
      identityPath,
    ]);

    return ok({
      identityPath,
      // The manual path needs the tagging UI before submit; the cluster path doesn't.
      next: identityPath === "manual" ? "manual-tagging" : "submit",
    });
  });
}

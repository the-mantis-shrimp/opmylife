/**
 * Consent: versioned, append-only. The biometric-consent checkbox is a DISTINCT
 * decision from ToS, written to its own `consents` row. faces.cluster runs only
 * if the LATEST biometric consent for the project is granted. This module is the
 * single gate everything else trusts — see docs/privacy-and-consent.md.
 *
 * Never update a consent in place: a changed decision is a NEW row.
 */
import { query, queryOne } from "../db";

export type ConsentKind = "biometric" | "tos" | "music_liability";

// Matches the effective date of the published Terms/Privacy (lib/legal.effectiveDate).
// Bump BOTH when the agreed wording changes.
export const POLICY_VERSION = "2026-07-10";

export async function recordConsent(args: {
  projectId: string;
  userId: string;
  kind: ConsentKind;
  granted: boolean;
  policyVersion?: string;
}): Promise<void> {
  await query(
    `INSERT INTO consents (project_id, user_id, kind, granted, policy_version)
     VALUES ($1,$2,$3,$4,$5)`,
    [args.projectId, args.userId, args.kind, args.granted, args.policyVersion ?? POLICY_VERSION],
  );
}

/** Latest decision for a (project, kind). The append-only table means "latest". */
export async function latestConsent(
  projectId: string,
  kind: ConsentKind,
): Promise<{ granted: boolean; policy_version: string } | null> {
  return queryOne(
    `SELECT granted, policy_version FROM consents
     WHERE project_id = $1 AND kind = $2
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, kind],
  );
}

/**
 * THE gate. True only if the latest biometric consent is explicitly granted.
 * faces.cluster MUST call this and skip (manual path) on false. No silent face
 * processing, ever.
 */
export async function biometricConsentGranted(projectId: string): Promise<boolean> {
  const c = await latestConsent(projectId, "biometric");
  return c?.granted === true;
}

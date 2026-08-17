/**
 * NCMEC CyberTipline reporting — integration point ONLY.
 *
 * ⚠️ Filing a CyberTipline report is a legal act under 18 U.S.C. § 2258A. To use
 * this you must (1) be a registered Electronic Service Provider with NCMEC, (2)
 * hold CyberTipline API credentials, and (3) have run your process past counsel.
 * Reporting is deliberately OPERATOR-TRIGGERED (a human confirms a flag first),
 * never auto-fired from the scan gate — a false auto-report is its own harm.
 *
 * This module records intent + wraps the submit call behind your credentials; the
 * exact request schema is defined by NCMEC's API docs (provided on ESP approval) —
 * wire `submitReport` to it. Until then `fileCyberTipReport` records the report as
 * `pending_manual` so nothing is silently dropped.
 */
import { query, queryOne } from "../db";
import { env } from "../env";
import { log } from "../logger";

export interface CyberTipReport {
  flagId: string;
  projectId: string;
  userId: string;
  /** R2 keys of the preserved offending file(s). Do NOT inline the bytes here. */
  fileKeys: string[];
  detectedBy: string;
  detail?: unknown;
}

/**
 * Record + (when configured) submit a CyberTipline report. Idempotent per flag —
 * a flag is reported at most once. Returns the resulting report status.
 */
export async function fileCyberTipReport(
  report: CyberTipReport,
): Promise<{ status: "reported" | "pending_manual"; ncmecReportId: string | null }> {
  // Dedup: never double-report the same flag.
  const existing = await queryOne<{ ncmec_report_id: string | null; status: string }>(
    `SELECT ncmec_report_id, status FROM moderation_flags WHERE id = $1`,
    [report.flagId],
  );
  if (existing?.status === "reported") {
    return { status: "reported", ncmecReportId: existing.ncmec_report_id };
  }

  if (!env.safety.ncmec.configured) {
    // No ESP credentials → the report cannot be filed programmatically. Flag it
    // for manual filing rather than dropping it.
    await query(`UPDATE moderation_flags SET status = 'pending_manual', updated_at = now() WHERE id = $1`, [
      report.flagId,
    ]);
    log.error("NCMEC report REQUIRED but not configured — file manually via CyberTipline", {
      flagId: report.flagId,
      projectId: report.projectId,
    });
    return { status: "pending_manual", ncmecReportId: null };
  }

  const ncmecReportId = await submitReport(report);
  await query(
    `UPDATE moderation_flags
       SET status = 'reported', ncmec_report_id = $2, reported_at = now(), updated_at = now()
     WHERE id = $1`,
    [report.flagId, ncmecReportId],
  );
  log.info("NCMEC CyberTipline report filed", { flagId: report.flagId, ncmecReportId });
  return { status: "reported", ncmecReportId };
}

/**
 * The actual NCMEC API call. STUB — wire to the CyberTipline request schema from
 * your ESP onboarding docs (report open → file upload → report finish). Left
 * unimplemented on purpose: don't ship a guessed legal-reporting payload.
 */
async function submitReport(_report: CyberTipReport): Promise<string> {
  throw new Error(
    "NCMEC submitReport is not implemented — wire it to the CyberTipline API per your ESP onboarding docs before enabling programmatic reporting.",
  );
}

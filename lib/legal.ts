/**
 * Shared constants for the legal pages + consent wording. Update the bracketed
 * placeholders (legal entity, jurisdiction, DMCA agent) with real values, and
 * create the contact inboxes, before relying on these publicly.
 */
export const LEGAL = {
  appName: "OPmylife",
  domain: "opmylife.com",
  legalEntity: "[Your legal entity / company name]",
  jurisdiction: "[Your state/country]",
  effectiveDate: "July 10, 2026",
  // One inbox for all contact — support, privacy, abuse, DMCA.
  supportEmail: "support.opmylife@gmail.com",
  privacyEmail: "support.opmylife@gmail.com",
  abuseEmail: "support.opmylife@gmail.com",
  dmcaEmail: "support.opmylife@gmail.com",
} as const;

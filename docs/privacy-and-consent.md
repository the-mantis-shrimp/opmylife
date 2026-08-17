# Privacy & Consent

This product processes **photos of real people** and runs them through third-party model APIs. The rules below are product invariants, not nice-to-haves. They appear in `CLAUDE.md` as always-do rules; this doc is the detail and the exact language constraints.

## The consent gate (built in from day one)

- The **biometric-consent checkbox is a distinct UI element, separate from the Terms of Service.** Agreeing to ToS does **not** grant biometric consent. They are different decisions and different rows.
- Each decision is written to its own row in `consents` (`kind='biometric'`), **versioned** with the `policy_version` the user agreed to, and **append-only** — a changed decision is a new row, never an in-place update.
- `faces.cluster` runs **only if** the latest biometric consent for the project is `granted=true`.
- **No consent → manual-tagging fallback.** The user labels who's who; this writes the same `characters` rows. There is **never** silent face processing on the no-consent path. Everything downstream of identity is identical between the two paths.

## Published legal + acceptable use

- The Terms and Privacy Policy are real pages at `/legal/terms` and `/legal/privacy` (`app/legal/*`), linked from the consent step and the site footer. Content constants (entity, jurisdiction, contact inboxes, effective date) live in `lib/legal.ts`; `POLICY_VERSION` (`lib/consent`) matches the effective date and is what consent rows record.
- **Before relying on these publicly:** have counsel review, fill the bracketed placeholders (`legalEntity`, `jurisdiction`, DMCA agent), and create the `support@` / `privacy@` / `abuse@` / `dmca@` inboxes.
- The Terms include an **acceptable-use policy** prohibiting illegal content, CSAM, non-consensual/intimate imagery, images of others without consent, infringing music, and harassment — with an `abuse@` reporting path and a DMCA process.

### ⚠ CSAM scanning — scaffolded, detector config-gated
A content-scan gate runs in `ingest.validate` **before any image reaches a model API** (`lib/safety`): flagged content is blocked, the project is placed on legal hold (exempt from deletion), and the user gets a neutral message. The **detector itself is pluggable and config-gated** — the live vendor integration + reporting are enabled by configuration, not on by default. Before scaling open, unauthenticated uploads you must wire a real vendor (e.g. PhotoDNA / Cloudflare CSAM Scanning / Thorn Safer) and, in the US, **register as an Electronic Service Provider with NCMEC** and file CyberTipline reports. This is a legal obligation, not optional — treat it as a launch blocker for open growth.

## What we store and where

- Uploaded photos and music live in **Cloudflare R2**, referenced by `assets.r2_key`.
- Derived artifacts (stylized character refs, shot clips, final MP4) also live in R2.
- App state lives in Postgres; the DB never stores the media bytes, only keys + metadata.

## TTL auto-deletion (server-side)

- Inputs and outputs are deleted on a **server-side schedule** — `cleanup.ttl` is scheduled when a render completes, backed by a sweeper over `projects.expires_at` and R2 lifecycle rules.
- **Never** tie deletion to browser close or session end. Renders are long-running and outlive the browser; a user can upload, close the tab, and come back to a finished render.
- The privacy promise we make to users is the TTL window — make sure the copy matches what the sweeper + lifecycle rules actually enforce.

## Encryption wording — be precise

- We provide **encryption at rest**. We do **not** provide end-to-end encryption, and must **never claim** it.
- Reason: plaintext media **must reach the third-party model APIs** to be processed (analysis, stylization, generation). E2E would make that impossible by definition. Any copy implying the provider can't see the content would be false.
- Approved framing: "encrypted at rest; processed by third-party AI providers to generate your video; auto-deleted after [TTL]." Avoid "private," "only you can see," "end-to-end," or "we never look at your photos" phrasing.

## Music & liability

- Default music is **generated** (Suno/Udio). The user-uploaded path is **opt-in**, and the user **accepts liability** for rights to any track they upload.
- Record that acceptance as a `consents` row (`kind='music_liability'`, versioned) — same append-only pattern as biometric consent.
- Users **own their output**; we sell the generation + sync, not the content.

## Third-party data flow (disclose, don't hide)

Photos and audio are sent to: the Vision LLM (analysis/storyboard), the image + i2v gateway (fal.ai/Replicate), and the music API. The privacy copy should disclose that processing happens at third-party providers — this is the direct consequence of "no E2E."

## Quick checklist for any consent/privacy-touching change

- [ ] Is biometric consent its own checkbox, separate from ToS?
- [ ] Is the decision written as a new versioned `consents` row (not an update)?
- [ ] Does `faces.cluster` still hard-gate on `granted=true`?
- [ ] Does the no-consent path reach identical `characters` rows via manual tagging?
- [ ] Is deletion server-side / TTL-driven, never browser-tied?
- [ ] Does the copy say "at rest," never "end-to-end"?

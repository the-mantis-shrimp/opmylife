# Build History

How OPmylife was built, phase by phase. This is a **record of delivered work**, not a
forward roadmap — the product is shipped and live. It's kept because the phasing and
per-task acceptance checks double as a map of the codebase.

Guiding goal of the early build: **prove the full pipeline runs durably, end to end, to a
watermarked output**, with the consent gate + manual fallback in the spine from day one.

---

## Phase 0 — Scaffolding ✅ shipped

| # | Task | Done when |
|---|---|---|
| 0.1 | Next.js app + single repo, `web` (`npm start`) and `worker` (`npm run worker`) entrypoints sharing `/lib`. | Both processes boot locally; worker connects to Redis. |
| 0.2 | `/db/schema.sql` from `data-model.md` + a migration runner. | `migrate` builds every table/enum on a fresh Postgres. |
| 0.3 | `/lib/db`, `/lib/queue` (BullMQ + queue names + job descriptor type), `/lib/storage` (R2 client + presign + TTL helper). | Can enqueue a no-op job and have the worker log it; can presign an R2 PUT. |
| 0.4 | Clerk auth on `web`; `users` row created/synced on first sign-in. | Signed-in user maps to a `users` row. |
| 0.5 | Railway project: Postgres + Redis plugins, `web` + `worker` services, env via reference variables, health check on `web`. | Both services deploy; `/api/health` green. (See `railway-deployment-topology.md`.) |

## Phase 1 — Thin vertical slice ✅ shipped

The spine: the durable pipeline and its invariants, end to end.

| # | Task | Done when |
|---|---|---|
| 1.1 | Project CRUD + dashboard; create project with a title. | User creates a project; row in `projects`. |
| 1.2 | Presigned photo upload (browser→R2); `assets` rows; `ingest.validate` stage. | Photos land in R2; invalid files rejected with reasons; `assets.validated` set. |
| 1.3 | **Consent step.** Biometric checkbox **separate from ToS**, writes a versioned `consents` row. | Decision persisted; `projects.identity_path` resolves to `cluster` or `manual`. |
| 1.4 | **Manual-tagging fallback UI** (no-consent path) writing `characters` rows. | No-consent users can label people; `characters` populated identically to the cluster path. |
| 1.5 | `faces.cluster` stage, **gated** on granted biometric consent; skips cleanly otherwise. | With consent → clusters to `characters`; without → stage `skipped`, no face processing occurs. |
| 1.6 | `album.analyze` + `characters.stylize`. | Each character gets a `ref_r2_key`. |
| 1.7 | `music.prepare` + `beat.detect`. | `music_tracks.beat_grid` populated. |
| 1.8 | `director.storyboard` → derive `shots`; `shots.generate` fan-out + join, **attempt cap** + **clip-reuse** honored. | Shots generate in parallel, join barrier holds, caps enforced. |
| 1.9 | `titlecard.render` deterministically (SVG/ffmpeg). | Title text is crisp and code-rendered, never model-rendered. |
| 1.10 | `assembly.compose` + `encode.final` producing a **watermarked** MP4; `deliver` to R2 + download link. | One project goes upload→download and plays. |
| 1.11 | **Charge point:** `charge_final` decrements the balance transactionally with `renders.charged=true`. Previews write **no** ledger entry. | Final encode writes exactly one `charge_final`; re-running it does not double-charge; previews are free. |
| 1.12 | `cleanup.ttl` server-side: schedule on completion + sweeper over `projects.expires_at`. | Inputs/outputs auto-delete after TTL with the browser closed. |
| 1.13 | Project-status endpoint reading stage + per-shot progress from Postgres; UI shows progress + failures. | UI reflects live stage + surfaces `job_runs.error`. |

## Phase 2 — Money + quality ✅ shipped

- **Stripe** wired: real credit purchase, webhook at `/api/stripe/webhook` granting credits idempotently (fulfilled from the webhook, never the client redirect), ledger `purchase` rows.
- Stubs swapped for **production image + i2v models** (Nano Banana Pro / FLUX Kontext; Kling 2.1, Kling v3 Pro, Veo 3.1) with per-shot routing.
- **Identity-consistency** and **beat-sync tightness** quality passes.
- User-uploaded music path hardened (liability accepted as a `consents` row, `kind='music_liability'`). *Generated music (Suno/Udio) remains a stub — upload is the shipped music path; with no upload the OP renders on a silent track of the chosen length.*

## Phase 3 — Product polish (partial)

- **Shipped:** shareable output pages + public gallery; multi-style presets (**Anime / Pixar / Fantasy**); an **Animate Me** mode that composes the people from a user's photos into brand-new scenes; **bilingual (EN/ES)** UI; **HEIC** upload.
- **Backlog:** project re-rolls from saved `style_meta` / `storyboards.plan`; per-render cost telemetry surfaced in-product; a possible move to **Inngest** — only if BullMQ stage-chaining becomes painful (it hasn't).

---

## How the codebase is organized

The build followed a few standing rules that still describe the code:

1. Specs are the source of truth: `CLAUDE.md` holds the locked decisions; each stage points to the spec that defines its contract (`data-model.md`, `pipeline.md`).
2. Work was taken **one numbered task at a time**, each satisfying its "done when" check.
3. Always-do rules (consent gate, charge-on-final-only, server-side TTL, deterministic titles) are hard constraints, enforced in code.
4. API routes stay thin; all heavy work goes through the queue into `worker`.

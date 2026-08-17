# CLAUDE.md

Context for building this app. Read at the start of every session. Keep responses aligned with the locked decisions below — they were made deliberately; flag, don't silently override.

## What we're building

A web app that takes a user's photo album + a song and produces a beat-synced, full-length anime opening (~90s). The app is an **orchestration layer over third-party AI model APIs**, a **durable job pipeline**, and **credit-based billing**. We sell the generation and sync; users own their content and assume liability for uploaded music.

## Stack (locked)

- **Frontend + API:** Next.js (React), one service `web`
- **Worker:** same repo, entry `npm run worker` — runs the pipeline + ffmpeg/Remotion assembly
- **Queue:** BullMQ on Redis (upgrade to Inngest only if step orchestration gets painful)
- **DB:** Postgres
- **Storage:** Cloudflare R2 (presigned browser uploads + lifecycle TTL deletion)
- **Model access:** fal.ai or Replicate gateway (i2v: Kling-class default; image; route per shot)
- **Vision LLM:** photo analysis + director/storyboard
- **Music:** Suno/Udio (generated default), user upload opt-in
- **Auth:** Clerk · **Billing:** Stripe
- **Host:** all on Railway (one project, private networking) except R2

## Repo layout (intended)

```
/app            Next.js routes (UI + API)
/lib            shared: db, storage, model clients, billing
/worker         worker entry + pipeline step processors
/pipeline       step definitions (analyze, stylize, storyboard, generate, assemble…)
/db             schema + migrations
/docs           project documentation (specs, plans — read these)
CLAUDE.md
README.md
```

## The render pipeline (order matters)

ingest.validate → album.analyze → faces.cluster* → characters.stylize → music.prepare + beat.detect → director.storyboard → shots.generate → titlecard.render → assembly.compose → encode.final + deliver → cleanup.ttl

\* `faces.cluster` runs **only if biometric consent is granted**; otherwise the manual-tagging path produces the same `characters` rows. Everything downstream is identical.

Full per-step contracts (inputs/outputs, model, retries, what each writes to the DB) live in `docs/pipeline.md`.

## Always-do rules

- **Consent gate is built in from day one, not deferred.** A distinct biometric-consent checkbox (separate from ToS), written to its own versioned `consents` row. No consent → manual-tagging fallback, never silent face processing.
- **Bill credits only on final encode.** Previews run on a cheap model, low-res, watermarked. Never charge for drafts or for your own retries.
- **TTL auto-deletion is server-side**, scheduled after render completes. Never tie deletion to browser close (renders outlive the session).
- **Title text is deterministic** (Remotion/SVG). Never ask a video model to render readable kanji/typography.
- **Never run heavy work in API routes.** Push a job descriptor to the queue; process in `worker`. API routes return fast.
- **Privacy wording is precise:** encryption-at-rest only, not end-to-end — plaintext must reach the model APIs to be processed. Don't claim E2E.
- **Cap retries per shot;** prefer clip reuse in editing over generating every cut (halves the generation bill).
- Datastore URLs come from Railway reference variables; never hardcode or expose a public DB domain.
- **CSAM scan gate runs in `ingest.validate`, BEFORE any image reaches a model API.** Never move image forwarding ahead of it. Flagged content → block + `legal_hold` (exempt from all deletion) + neutral user message; detector + NCMEC reporting are external/creds-gated. See `lib/safety`.

## Build status

Shipped and live at opmylife.com. The full pipeline runs end-to-end — stylization, storyboard, beat-synced generation, assembly, and final encode — with the consent gate + manual-tagging fallback in the spine, credit/token billing on final encode, and server-side TTL cleanup.

## Documentation map

All detailed docs live in `docs/`. Read the ones relevant to the task:

| Doc | When to read it |
|---|---|
| `docs/product-spec.md` | What we're building, the user journey, scope, non-goals |
| `docs/architecture.md` | System shape, repo layout, the sync→async boundary |
| `docs/data-model.md` | Postgres schema — tables, enums, relationships (the "build-doc schema") |
| `docs/pipeline.md` | Per-step pipeline contracts, the consent branch, beat-sync, charge point |
| `docs/build-plan.md` | Build history — how it was shipped, phase by phase, with the remaining backlog |
| `docs/railway-deployment-topology.md` | Deployment topology, services, env vars, setup order |
| `docs/scaling-and-resources.md` | Railway CPU/RAM limits, replicas, worker concurrency, env→branch mapping, scaling triggers |
| `docs/privacy-and-consent.md` | Consent gate, biometric handling, TTL, exact privacy wording |
| `docs/setup.md` | Step-by-step going-live guide: hosting accounts + third-party integrations + which env var each fills |

Start a build session by reading this file, then `docs/build-plan.md` for the current phase, then whichever spec covers the task at hand.

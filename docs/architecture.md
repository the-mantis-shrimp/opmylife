# Architecture

## System shape

Two processes sharing one codebase, plus managed datastores and external APIs.

```
Browser ──presigned upload──► Cloudflare R2
   │
   │ HTTPS
   ▼
web (Next.js: UI + API routes)
   │  · auth (Clerk), project CRUD
   │  · issues presigned upload URLs
   │  · enqueues pipeline jobs, returns fast
   │  · Stripe webhooks, serves preview/download
   │
   ▼ enqueue (private network)
Redis (BullMQ) ◄────────────┐
   │ dequeue (private)      │
   ▼                        │ re-enqueue next stage
worker (same codebase, `npm run worker`)
   │  · runs pipeline steps
   │  · calls external model APIs
   │  · ffmpeg/Remotion assembly (CPU only)
   │  · read/write R2 (presigned), read/write Postgres
   ▼
Postgres (app state, job/stage status, ledger)
```

External APIs (off-Railway): fal.ai/Replicate (image + i2v), a Vision LLM (analysis + storyboard), Suno/Udio (music), Stripe (billing), Clerk (auth). Full deployment topology and env vars: `railway-deployment-topology.md`.

## The one rule that drives the whole design

**API routes never do heavy work.** A request validates, writes a row, pushes a job descriptor to the queue, and returns. All generation, model calls, and ffmpeg happen in `worker`. This keeps the web tier responsive and lets renders outlive any single HTTP request or browser session (which is also why TTL deletion is server-side, not tied to the browser).

## Repo layout

```
/app            Next.js routes
  /app/(ui)       pages: dashboard, project, upload, consent, preview, download
  /app/api        route handlers: projects, uploads (presign), jobs, stripe/webhook, health
/lib            shared modules used by BOTH web and worker
  /lib/db          Postgres client + query helpers
  /lib/queue       BullMQ setup, queue names, job descriptors
  /lib/storage     R2 client, presign, TTL helpers
  /lib/models      typed clients: gateway (fal/replicate), vision LLM, music
  /lib/billing     credit ledger, charge-on-final logic, Stripe
  /lib/consent     consent read/write, path selection (cluster vs manual)
/worker         worker entry (`worker/index.ts`) — registers BullMQ processors
/pipeline       one module per stage; pure-ish step fns the worker invokes
/db             schema.sql + migrations
/docs           this documentation
CLAUDE.md
README.md
```

`web` start command: `npm start`. `worker` start command: `npm run worker`. Same image, same env (minus client-only keys on the worker). See deployment doc.

## Job model

- Each pipeline **stage is a BullMQ job**. A job carries `{ projectId, stage, attempt }` and reads everything else from Postgres (the DB is the source of truth, the queue just schedules work).
- On success, a stage **enqueues the next stage** (or fans out — `shots.generate` enqueues one job per shot, then a join step waits for all shots before `assembly.compose`).
- Stages are **idempotent**: re-running a stage for a project must not duplicate rows or double-charge. Use the DB status columns + natural keys (e.g. `shots.idx`) to make re-entry safe.
- Retries/backoff are per-job; **per-shot retries are capped** (cost control). Failures mark the stage `failed` with an error payload the UI can surface.

See `pipeline.md` for each stage's contract and `data-model.md` for the status columns.

## Async progress to the browser

The UI polls a project-status endpoint (or subscribes via SSE) that reads the current stage + per-shot progress from Postgres. No long-held connections; the queue/DB are the coordination layer.

## Orchestration upgrade path

Default is hand-rolled BullMQ stage-chaining. If the durable-workflow logic gets painful — fan-out, waiting on vendor webhooks, retrying across ~10 stages — drop in **Inngest** for orchestration only, leaving everything else on Railway. Don't reach for it preemptively (see deployment doc).

## Why these choices (brief)

- **Single codebase, two entrypoints**: shared types/clients between API and worker, one deploy artifact.
- **BullMQ/Redis over a workflow SaaS**: cheapest, all-Railway, good enough until proven otherwise.
- **R2 over a Railway volume**: needs presigned browser uploads + native TTL lifecycle deletion; volumes give neither, and R2 egress is free.
- **Model gateway (fal/replicate)**: one integration, swap i2v/image models per shot without re-plumbing.

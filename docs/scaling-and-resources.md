# Scaling & resource limits

Recommended Railway sizing for `web` and `worker`, plus Postgres/Redis, and when to scale. Companion to [`railway-deployment-topology.md`](./railway-deployment-topology.md).

## The one principle that governs everything

On Railway's usage-based (Pro) plan, a service's resource setting is a **ceiling, not a reservation** — you pay for what a service actually consumes, not for the cap. So:

- Leaving every service at the plan maximum (e.g. 24 vCPU / 24 GB) costs nothing at idle **but removes your only guardrail**: a bug (memory leak, runaway ffmpeg, infinite loop) can consume the whole cap across services and run up a real usage bill before you notice.
- **Right-size each cap comfortably above real peak, so it bounds the blast radius of a runaway** — not so tight that it kills legitimate work.
- On Railway the **memory limit is a hard cap**: a service that exceeds it is OOM-killed (`SIGKILL`). The worker's limit must sit *above* ffmpeg's peak, which is exactly the earlier `assembly.compose` / `encode.final` OOM.

Reality check: **more vCPU does not make generations faster.** Most of a render's wall-clock is spent awaiting the fal/Anthropic APIs (I/O), not local CPU. CPU only matters for the ffmpeg stages. Sizing here is about headroom and safety, not speed.

## Recommended limits (launch baseline)

| Service | Limit vCPU | Limit RAM | Replicas | Rationale |
|---|---|---|---|---|
| **worker** | 8 | 8 GB | 2 | Heavy: ffmpeg + model orchestration. Room for concurrent encodes; 8 GB caps a runaway. 2 replicas for redundancy. |
| **web** | 2 | 2 GB | 2 | Thin API (validate → enqueue → return). 2 replicas = zero-downtime deploys + redundancy. |
| **Postgres** | 4 | 4 GB | 1 | DB is small — text rows + credit ledger; all media lives in R2. |
| **Redis** | 2 | 2 GB | 1 | BullMQ payloads are tiny; job retention is already capped in code (`removeOnComplete`/`removeOnFail`). |

These are starting points. Run for ~a week, read Railway's metrics graphs, and lift a specific cap only if that service actually approaches it.

## Why the worker is the one that matters

The worker runs the pipeline stages, but the resource-heavy part is **ffmpeg** (`beat.detect`, `titlecard.render`, `assembly.compose`, `encode.final`). Everything else is DB I/O or awaiting model APIs.

- ffmpeg is capped to `-threads 2` with fast/veryfast presets, so one 720p/1080p encode peaks around ~0.5–1 GB. **2 GB** covers typical overlap; the recommended **8 GB** cap gives comfortable headroom for two projects hitting encode at once plus concurrency, while still bounding a runaway.
- CPU: h264 encoding is CPU-bound and uses up to 2 vCPU per encode; 8 vCPU covers several concurrent encodes.

## Replicas — don't run un-replicated

Replicas are for **redundancy and clean deploys**, not raw throughput (one worker already runs `WORKER_CONCURRENCY` jobs in parallel).

- **web: 2** — stateless (sessions in Clerk, data in Postgres), so this is free redundancy and zero-downtime deploys.
- **worker: 2** — with a single worker, a crash or redeploy **stalls all job processing** until it restarts (jobs stay queued and resume, but there's a gap). Two replicas keep the queue draining through deploys/crashes.
- **Postgres & Redis: 1 each** — managed stateful services aren't casually replicated on Railway; size the limit and leave single.

## `WORKER_CONCURRENCY`

- Default is `5` (jobs processed in parallel per worker instance; most are I/O-bound waits on the model APIs).
- It doubles as your **spend throttle** — every concurrent `shots.generate` job is a paid fal call. Higher concurrency speeds up multi-shot fan-out and lets more projects run at once, but raises simultaneous spend and rate-limit pressure.
- Keep at **5**; raise only if the queue backs up *and* your model-API budget + rate limits allow.

## Postgres connection math

The pg pool is `max: 10` **per instance** (`lib/db`). Total connections ≈ `(web replicas + worker replicas) × 10`.

- Baseline 2 web + 2 worker = **~40 connections** — safe under Pro Postgres limits.
- If you push worker replicas to 5+, you approach the ceiling (50+ from workers alone). At that point either lower the pool `max` or put **PgBouncer** in front of Postgres.

## When to scale up (watch these signals)

| Signal | Action |
|---|---|
| BullMQ `waiting` count grows during peak | Add a worker replica |
| Worker RAM pinned near limit / any `SIGKILL` | Raise worker RAM cap, or drop `WORKER_CONCURRENCY` to 3 |
| Worker CPU pegged at 100% with a growing queue | Add a worker replica or vCPU |
| Postgres connections climbing toward `max_connections` | Add PgBouncer or lower pool `max` |

## Environments → branches

Deploys are wired per environment to a Git branch:

| Environment | Branch | Keys / datastores |
|---|---|---|
| `production` | `main` | Live Stripe + Clerk production instance; its own Postgres/Redis/R2 |
| `test` | `test` | Stripe test + Clerk dev keys; **separate** Postgres/Redis/R2 (never shares prod data) |

Set the branch per service under **Settings → Source** in each environment. Keep production careful (build in `test`, promote to `main`); confirm the two environments point at **different** datastores so test activity can never touch prod data.

# Deployment Topology — All-Railway

One Railway project holds everything that needs private networking; a few external SaaS pieces handle the work Railway shouldn't. Heavy AI generation is offloaded to model APIs, so **your own compute is CPU-only (ffmpeg/orchestration) — no GPUs to host.**

```
                 ┌──────────────── Railway project ────────────────┐
   Browser ──────►  web (Next.js, public domain)                    │
   presigned        │  · auth, project CRUD, presigned upload URLs  │
   upload           │  · enqueue jobs, Stripe webhooks, serve UI    │
      │             │           │ enqueue (private)                 │
      │             ▼           ▼                                    │
      │          Postgres ◄── Redis (BullMQ queue) ◄──┐             │
      │             ▲           ▲                      │             │
      │             │           │ dequeue (private)    │             │
      │          worker (Next.js codebase, worker entry)            │
      │             │  · runs pipeline steps + ffmpeg assembly      │
      └─────────────┼──────────────────────────────────────────────┘
                    │ read/write (presigned)
                    ▼
        Cloudflare R2  ──TTL lifecycle auto-delete──►  (privacy promise)
                    ▲
   external APIs ───┤  fal.ai / Replicate (i2v + image models)
                    │  Vision LLM (Gemini/Claude/OpenAI)
                    │  Suno / Udio (music)
                    │  Stripe (billing) · Clerk (auth)
```

---

## Railway services (one project)

| Service | What it is | Public? |
|---|---|---|
| **web** | Next.js — frontend + API routes. Issues presigned uploads, enqueues jobs, handles Stripe webhooks, serves preview/download. | Yes (domain) |
| **worker** | Same repo, different start command. Pulls jobs from Redis, runs the pipeline steps, does ffmpeg/Remotion assembly. Long-running. | No |
| **Postgres** | Railway managed. App data (see build-doc schema). | No (private) |
| **Redis** | Railway managed. BullMQ queue backend + caching/rate-limit. | No (private) |

`web` and `worker` share one codebase, different entry points (`npm start` vs `npm run worker`).

## External services (and why each is off-Railway)

- **Cloudflare R2** — object storage. *The one deliberate non-Railway piece.* Your privacy design needs (a) direct browser→storage presigned uploads and (b) lifecycle rules that auto-delete inputs/outputs after N hours. R2 does both natively with zero egress fees; a Railway volume is attached-disk storage and doesn't give you presigned uploads or TTL deletion. Worth keeping external.
- **fal.ai or Replicate** — unified gateway for i2v (Kling/Veo/Luma) + image models. One integration, swap models per shot.
- **Vision LLM** — photo analysis + director/storyboard.
- **Suno/Udio** — generated-music path.
- **Stripe** — billing/credits.
- **Clerk** (or Supabase Auth) — auth.

---

## Orchestration choice

**Default: BullMQ on Railway Redis.** Truly all-Railway, no external workflow SaaS, cheapest. The `worker` service runs BullMQ processors; encode each pipeline stage as a job with retries/backoff.

**Upgrade path (don't reach for it yet):** if the durable-workflow logic gets painful — fan-out one job per shot, waiting on vendor webhooks, retrying across ~10 stages — drop in **Inngest** (generous free tier) for just the orchestration. It slots in without moving anything else off Railway. Start with BullMQ; switch only if the hand-rolled retry/step code starts hurting.

---

## Environment variables

Set datastore URLs via Railway **reference variables** so they resolve over the private network — never hardcode, never expose a public DB domain.

**web:**
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
APP_URL=https://<your-domain>
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
MODEL_GATEWAY_KEY        # fal.ai / Replicate
VISION_LLM_KEY
MUSIC_API_KEY            # Suno/Udio
```

**worker:** (does the processing, so it needs the generation creds — but no Stripe/auth client keys)
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
MODEL_GATEWAY_KEY
VISION_LLM_KEY
MUSIC_API_KEY
```

---

## Setup order

1. **Create the Railway project.** Add **Postgres** and **Redis** plugins first so their reference variables exist.
2. **Deploy `web`** from the GitHub repo. Start command `npm start`. Add the env vars above (use `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}` references). Assign a public domain.
3. **Add `worker`** as a second service from the **same repo**, start command `npm run worker`. Share `DATABASE_URL` / `REDIS_URL` via the same references. No public domain.
4. **Health + resilience.** Health check endpoint on `web`; set both services' restart policy to auto-restart on crash.
5. **Environments.** Use Railway environments to run **staging** and **production** separately.
6. **External wiring.** Create R2 bucket + lifecycle TTL rule; set fal.ai/Replicate, Vision LLM, Suno, Stripe, Clerk accounts; paste keys into env vars.
7. **Stripe webhook** → point at `https://<your-domain>/api/stripe/webhook`.

---

## Cost shape

Hosting is the *small* line item: two small services + Postgres + Redis at MVP scale runs low on Railway's usage-based model (there's a small trial credit to start), and it scales with traffic rather than spiking on serverless function time. **The variable cost that actually matters is the model APIs billed per render (~$15–60 per OP), not hosting** — which is exactly why billing charges credits only on final encode. R2 adds a few dollars; egress is free.

Switch from usage-based forecasting anxiety to fixed monthly only if you later prefer predictability over scale-to-low — at which point Render is the fixed-price equivalent. For now Railway is the cheaper, simpler fit.

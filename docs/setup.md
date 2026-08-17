# Setup — hosting accounts & third-party integrations

Step-by-step to take this from "runs locally in stub mode" to "deployed and wired to real
services" — the setup path behind the live product. Do the stages roughly in order; you can
stop after Stage 2 for a working deploy on stub models, then add real models (Stage 3) and
billing (Stage 4).

Each service lists the **env vars** it fills. The full var reference is in
[`.env.example`](./.env.example) and [`docs/railway-deployment-topology.md`](./docs/railway-deployment-topology.md).

> **Privacy wording (don't drift):** "encrypted at rest; processed by third-party AI providers
> to generate your video; auto-deleted after [TTL]." Never claim end-to-end encryption — plaintext
> must reach the model APIs. See [`docs/privacy-and-consent.md`](./docs/privacy-and-consent.md).

---

## Stage 0 — Local prerequisites (already done if the app booted)

- **Node 20+** and **npm**.
- **Docker Desktop** — for local Postgres + Redis (`docker compose up -d`).
- **ffmpeg** on your PATH — needed for real audio/video in stub mode and for assembly/encode.
  - Windows: `winget install Gyan.FFmpeg` · macOS: `brew install ffmpeg` · Linux: `apt install ffmpeg`.
- Copy env and migrate: `cp .env.example .env.local` → `npm run migrate`.

You can build the whole pipeline locally with **no external accounts** (`MODELS_MODE=stub`,
local-filesystem storage, dev user). Everything below replaces a stub with a real service.

---

## Stage 1 — Hosting accounts

### 1a. Railway (web + worker + Postgres + Redis)

This is the one project that holds everything needing private networking.

1. Create an account at <https://railway.app> and a **new project**.
2. **Add the datastores first** (so their reference variables exist):
   - **+ New → Database → PostgreSQL**
   - **+ New → Database → Redis**
3. **Deploy `web`:** **+ New → GitHub Repo** → pick this repo.
   - Build: Dockerfile (the repo includes one and `railway.json`).
   - **Start command:** Settings → Deploy → Custom Start Command → `npm start`.
   - **Health check path:** Settings → Deploy → Healthcheck Path → `/api/health`.
     `railway.json` deliberately sets **neither** of these repo-wide — both apply to every
     service built from this repo (including `worker`, which has no HTTP server at all), so a
     shared value would lock/override the dashboard on `web` and fail health checks forever on
     `worker`. Set both explicitly here, per service.
   - **Variables** (use Railway *reference variables* for datastores — never hardcode a public DB URL):
     ```
     DATABASE_URL=${{Postgres.DATABASE_URL}}
     REDIS_URL=${{Redis.REDIS_URL}}
     APP_URL=https://<your-web-domain>
     MODELS_MODE=stub            # flip to "live" after Stage 3
     STARTING_CREDIT_GRANT=100
     FINAL_ENCODE_COST=10
     RENDER_TTL_HOURS=72
     ```
   - Networking → **Generate Domain** (public).
4. **Add `worker`:** **+ New → GitHub Repo → same repo** (second service).
   - **Start command:** Settings → Deploy → Custom Start Command → `npm run worker`. If this
     field is greyed out / says it's set by `railway.json`, that's the shared-config issue
     above — make sure you're on a commit that removed `startCommand` from `railway.json`.
   - **Leave Healthcheck Path blank.** The worker has no HTTP server — if a healthcheck path is
     set (inherited from `web`'s settings or a stale `railway.json`), Railway will probe it,
     get nothing, and fail the deploy in a restart loop. Blank means Railway just watches the
     process for a clean exit/crash, which is the correct check for a background worker.
   - **No public domain.**
   - Variables: same `DATABASE_URL` / `REDIS_URL` references, plus the model keys from Stage 3.
     The worker does **not** need Clerk or Stripe keys.
5. **Run the migration once** against the Railway Postgres — `npm run migrate` applies
   `db/schema.sql` (idempotent; re-run after any schema change). `${{Postgres.DATABASE_URL}}`
   is the *private* URL, unreachable from your laptop, so use one of:
   - **In-network (recommended):** temporarily set the `web` start command to
     `npm run migrate && npm start`, deploy once, then revert it to `npm start`.
   - **From your machine:** grab the **public** string from the Postgres service →
     **Connect** tab (`DATABASE_PUBLIC_URL`), then run
     `DATABASE_URL=<public-url> npm run migrate` (PowerShell:
     `$env:DATABASE_URL="<public-url>"; npm run migrate`).
   - Success prints `✓ Schema applied.`
6. **Resilience:** set both services' restart policy to auto-restart on failure (already in `railway.json`).
7. **Environments:** use Railway **environments** to keep **staging** and **production** separate.

Fills: `DATABASE_URL`, `REDIS_URL`, `APP_URL`.

### 1b. Cloudflare R2 (object storage) — the one deliberately non-Railway piece

Needed for direct browser→storage presigned uploads **and** lifecycle TTL auto-deletion (a Railway
volume gives neither). Egress is free.

1. Cloudflare dashboard → **R2** → **Create bucket** (e.g. `anime-op-prod`).
2. **Manage R2 API Tokens** → create a token with **Object Read & Write** on that bucket.
3. **Lifecycle rule:** R2 bucket → **Settings → Object lifecycle rules** → add a rule that
   **deletes objects after N days** (match `RENDER_TTL_HOURS`). This backs the privacy promise at
   the storage layer; the app's `cleanup.ttl` stage + sweeper are the belt-and-braces complement.
4. **CORS** (R2 bucket → **Settings → CORS policy**): allow `PUT` for browser uploads **and** `GET`
   for the "Share" button (it fetches the finished video as a Blob to hand to the OS share sheet).
   Without `GET`, quickshare degrades to sharing a link instead of the file. Add your app origin:
   ```json
   [{ "AllowedOrigins": ["https://opmylife.com"], "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["*"] }]
   ```
5. Add to **both** `web` and `worker` variables:
   ```
   R2_ACCOUNT_ID=<cloudflare account id>
   R2_ACCESS_KEY_ID=<token access key>
   R2_SECRET_ACCESS_KEY=<token secret>
   R2_BUCKET=anime-op-prod
   # optional: R2_PUBLIC_BASE_URL=https://<custom-domain-fronting-the-bucket>
   ```

Once these are set, the app automatically switches from the local-filesystem driver to R2
(`lib/storage` detects credentials). Fills: `R2_*`.

---

## Stage 2 — Auth (Clerk)

Until you do this, your deployed URL has **no real auth** — every visitor is one shared dev user
(that's why `/api/projects` returns data without signing in). Stage 2 closes that.

**How the app behaves:** the moment both Clerk keys are present, the app switches on automatically —
`middleware.ts` redirects signed-out visitors from the dashboard/project pages to `/sign-in`, the
header shows a user menu, and `lib/auth` resolves the *real* signed-in user (mirrored into the
`users` table + seeded a starter credit grant on first request). No keys → the dev-user fallback.
The sign-in/up pages (`/sign-in`, `/sign-up`) and the user menu already exist in the code.

### 2a. Create the Clerk application
1. Sign up at <https://clerk.com> and click **Create application**.
2. Name it (e.g. `ai-anime-op`), choose the **sign-in methods** you want (Email + Google is a fine
   default), then **Create application**.

### 2b. Copy the API keys
3. In the new app: left sidebar → **Configure → API keys** (or the "Quickstart" pane).
4. Copy the two values:
   - **Publishable key** → `pk_test_...` (or `pk_live_...`)
   - **Secret key** → `sk_test_...` (click to reveal). Treat this like a password.

### 2c. Set the variables on the `web` service (worker needs none of these)
5. Railway → **web** service → **Variables** → add:
   ```
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
   CLERK_SECRET_KEY=sk_...
   NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
   NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
   NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
   NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/
   ```
   The four `NEXT_PUBLIC_CLERK_*_URL` vars point Clerk at the in-app pages (without them Clerk
   sends users to its hosted pages instead — these keep everything on your domain). Saving
   variables triggers a redeploy.

### 2d. Tell Clerk about your domain
6. In Clerk → **Configure → Domains** (or **Paths**), make sure your production origin
   `https://<your-web-domain>` is allowed. For a **development** instance the `pk_test`/`sk_test`
   keys work on any origin, so you can skip this until you create a **production** instance
   (Clerk → top-left environment switch → **Production**, which issues `pk_live`/`sk_live` keys and
   requires verifying a domain).

### 2e. Verify
7. After the redeploy, open `https://<your-web-domain>/` in a private window → you should be
   **redirected to `/sign-in`**.
8. Sign up / sign in → you land back on the dashboard with a **user menu** in the header, and your
   **own** empty project list (a fresh `users` row + 100-credit grant, not the shared dev user).
9. Sanity check the API is now gated: hitting `https://<your-web-domain>/api/projects` while signed
   out should return **401** (it returned `200` before Stage 2).

Fills: `CLERK_*`, `NEXT_PUBLIC_CLERK_*`.

> **After Stage 2 you have a working deploy on stub models:** real auth + storage, no
> billing yet. Keep `MODELS_MODE=stub` until Stage 3.

---

## Stage 3 — Model APIs (flip `MODELS_MODE=live`)

The variable cost that actually matters is here (~$15–60 per final render), which is why credits
are charged only on final encode. Wire these on the **`worker`** (it does the processing); `web`
only needs them if you surface model config.

> **Go live one model at a time.** Each integration has its own mode override —
> `VISION_MODE`, `GATEWAY_MODE`, `MUSIC_MODE` — falling back to the global `MODELS_MODE`.
> E.g. set `VISION_MODE=live` on the worker while the other two stay stubbed.

### 3a. Vision LLM — photo analysis + director/storyboard ✅ WIRED
Implemented in `lib/models/vision.ts` using Claude (Anthropic API).
1. Get an API key at <https://console.anthropic.com> (Settings → API keys).
2. Set on the **worker**: `VISION_LLM_KEY=sk-ant-...` and `VISION_MODE=live`.
   Optional: `VISION_LLM_MODEL` (default `claude-opus-4-8`).
3. **Verify without running the pipeline:** locally with the key in `.env.local`, run
   `npm run vision:check` — it makes one small real storyboard request and prints the
   planned shots (or the exact API error).

What it does live: photos go to the model as images (HEIC is skipped — convert to JPEG for
now); analysis/clustering/storyboard come back as schema-constrained JSON; beat alignment is
enforced in code by snapping every cut to the beat grid. `clusterFaces` stays consent-gated —
the stage checks the consent row before this client is ever called.

### 3b. Image + i2v gateway — fal.ai ✅ WIRED
Implemented in `lib/models/gateway.ts` via fal.ai, with **model routes as env config** —
any fal-hosted model (Kling, Veo, Wan, …) is one variable away, no code changes.
1. Create an account at <https://fal.ai> → dashboard → **Keys** → create an API key.
2. Set on the **worker**: `MODEL_GATEWAY_KEY=...` and `GATEWAY_MODE=live`.
3. Optional route overrides (defaults shown in `.env.example`):
   - `IMAGE_MODEL` — photo → anime character ref (default `fal-ai/nano-banana/edit`)
   - `I2V_MODEL_PREVIEW` — cheap route for free previews (default Kling 2.1 standard)
   - `I2V_MODEL_FINAL` — premium route for charged finals (default Kling v3 pro).
     **Want Google's video model? Set this to a Veo endpoint** (e.g.
     `fal-ai/veo3.1/image-to-video`) — Veo is hosted on fal, so no separate GCP setup.
4. **Verify:** `npm run gateway:check` validates the key + image route for ~$0.05
   (add `GATEWAY_CHECK_VIDEO=1` to also test one 5s preview-route video, ~$0.25–0.50).

Cost shape: the i2v calls are THE variable cost (roughly $0.05–0.10/s preview-tier,
$0.20–0.75/s premium-tier). Clip reuse + attempt caps in the pipeline keep this bounded;
previews always use the cheap route.

### 3c. Music — generated tracks (Suno / Udio) — optional, not wired
The shipped music path is **user upload** (with beat detection running on the uploaded track).
Generated music is scaffolded but not connected. To add it:
- Account + API key from your chosen provider.
- Implement `generateTrack` in `lib/models/music.ts` (beat detection already runs on CPU — see `lib/beat.ts`).
- Vars: `MUSIC_API_KEY`, then `MUSIC_MODE=live`.

Image + i2v are the two you need live; once set you can use the single `MODELS_MODE=live` and drop the overrides.

---

## Stage 4 — Billing (Stripe)

Token/credit purchases are fully wired. To connect your own Stripe account:

1. Create a <https://stripe.com> account; get the **secret key**.
2. Create a **webhook endpoint** pointing at `https://<your-web-domain>/api/stripe/webhook`;
   copy the **signing secret**.
3. Add to **`web`** variables:
   ```
   STRIPE_SECRET_KEY=sk_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

That's it — the code handles the rest. `app/api/stripe/webhook/route.ts` is thin +
signature-verified and, on `checkout.session.completed` (paid), records the purchase
idempotently on the session id (so Stripe's retries never double-grant), fulfilling only from
the webhook and never the client redirect. The charge-on-final logic (`lib/billing`) is separate,
decrements the ledger transactionally, and is idempotent. Fills: `STRIPE_*`.

---

## Quick checklist

- [ ] Railway project with Postgres + Redis, `web` (public) + `worker` (private)
- [ ] `DATABASE_URL` / `REDIS_URL` via reference variables; `npm run migrate` run once
- [ ] `/api/health` returns 200 (Postgres + Redis reachable)
- [ ] R2 bucket + API token + **lifecycle TTL rule**; `R2_*` on both services
- [ ] Clerk keys on `web`; sign-in works; `users` row created
- [ ] Generate a **preview** end to end (free, watermarked)
- [ ] Generate a **final** (charges credits; exactly one `charge_final`, no double-charge)
- [ ] (Stage 3) real model keys + `MODELS_MODE=live`
- [ ] (Stage 4) Stripe webhook at `/api/stripe/webhook`

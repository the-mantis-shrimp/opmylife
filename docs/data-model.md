# Data Model

Postgres. This is the "build-doc schema" referenced in `CLAUDE.md`. The DB is the **source of truth**; the queue only schedules work. Every pipeline stage reads its inputs from here and writes its outputs/status back here so stages are idempotent and re-runnable.

Conventions: `id` is a UUID (`gen_random_uuid()`), timestamps are `timestamptz` defaulting to `now()`, every table has `created_at` (and `updated_at` where it's mutated). Foreign keys cascade on delete of the owning `project` unless noted — TTL cleanup deletes the project and lets the data go with it.

## Enums

```sql
CREATE TYPE project_status AS ENUM (
  'draft', 'ingesting', 'analyzing', 'styling', 'storyboarding',
  'generating', 'assembling', 'encoding', 'ready', 'failed', 'expired'
);

CREATE TYPE stage_name AS ENUM (
  'ingest.validate', 'album.analyze', 'faces.cluster', 'characters.stylize',
  'music.prepare', 'beat.detect', 'director.storyboard', 'shots.generate',
  'titlecard.render', 'assembly.compose', 'encode.final', 'deliver', 'cleanup.ttl'
);

CREATE TYPE stage_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');

CREATE TYPE asset_kind  AS ENUM ('photo', 'music_upload');
CREATE TYPE identity_path AS ENUM ('cluster', 'manual'); -- how characters were derived
CREATE TYPE render_kind  AS ENUM ('preview', 'final');
CREATE TYPE music_source AS ENUM ('generated', 'uploaded');
CREATE TYPE ledger_reason AS ENUM ('grant', 'purchase', 'charge_final', 'refund', 'adjust');
```

## Tables

### users
Mirror of Clerk identity. We key everything to our own `users.id` and store the Clerk subject.

```sql
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id     text UNIQUE NOT NULL,
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

### projects
One generation = one project. `identity_path` records whether the cast came from clustering or manual tagging (both produce identical `characters` rows downstream).

```sql
CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL,                 -- used on the title card
  status         project_status NOT NULL DEFAULT 'draft',
  identity_path  identity_path,                 -- set after the consent step
  music_source   music_source,
  expires_at     timestamptz,                   -- TTL target; cleanup.ttl deletes at/after this
  error          jsonb,                         -- last failure detail for the UI
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON projects (user_id);
CREATE INDEX ON projects (status);
CREATE INDEX ON projects (expires_at);          -- cleanup sweeper scans this
```

### consents
**Versioned, append-only.** The biometric consent is its own row, distinct from ToS. Never update in place — a new decision is a new row. `faces.cluster` runs only if the latest biometric consent for the project is `granted=true`.

```sql
CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL,                  -- e.g. 'biometric', 'tos', 'music_liability'
  granted       boolean NOT NULL,
  policy_version text NOT NULL,                 -- which wording they agreed to
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON consents (project_id, kind, created_at DESC);
```

### assets
Uploaded inputs (photos, optional music). Files live in R2; this row holds the key + metadata. Direct browser→R2 presigned upload; the row is created/confirmed by the API.

```sql
CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          asset_kind NOT NULL,
  r2_key        text NOT NULL,
  mime          text,
  bytes         bigint,
  width         int,
  height        int,
  position      int NOT NULL DEFAULT 0,         -- user-controlled display order
  validated     boolean NOT NULL DEFAULT false, -- set by ingest.validate
  meta          jsonb,                          -- analysis hints (album.analyze may annotate)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON assets (project_id, kind);
```

### characters
The stylized cast. Produced either from face clusters (consent path) or manual tags (no-consent path) — **same columns either way**. `ref_r2_key` points at ONE stylized reference image per person, reused across every shot that features them — this is what keeps a person looking consistent across the whole video.

```sql
CREATE TABLE characters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         text,                           -- display name ("Andrew", "Mom")
  source_asset_ids uuid[] NOT NULL,             -- photos that fed this character
  ref_r2_key    text,                           -- stylized reference image (characters.stylize)
  style_meta    jsonb,                          -- prompt/seed/model used, for re-rolls
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON characters (project_id);
```

### music_tracks
The chosen track (generated or uploaded) plus beat analysis. Real songs aren't
authored to end at ~90s, so `duration_ms` is the **full** track length and
`trim_start_ms`/`trim_end_ms` select the **OP window** cut from it. The effective
OP length = `trim_end_ms - trim_start_ms` (resolved/clamped in `lib/music`,
15–120s). `beat_grid` is computed over the trimmed window.

```sql
CREATE TABLE music_tracks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source        music_source NOT NULL,
  r2_key        text NOT NULL,                  -- full track (the UI scrubber plays this)
  duration_ms   int,                            -- full track duration
  trim_start_ms int NOT NULL DEFAULT 0,         -- OP window start within the track
  trim_end_ms   int,                            -- OP window end (null → defaulted in music.prepare)
  bpm           numeric,
  beat_grid     jsonb,                          -- beat timestamps + section markers, over the trimmed window
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON music_tracks (project_id);
```

### storyboards
Director output: the timed shot list, cut to the beat grid. The `shots` rows are derived from this.

```sql
CREATE TABLE storyboards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan          jsonb NOT NULL,                 -- full storyboard (shots, timings, character refs)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON storyboards (project_id);
```

### shots
One row per shot. `shots.generate` fans out one job per row; the join waits until every shot for the active `render_kind` is `succeeded`. `idx` is the natural key that makes generation idempotent and ordering deterministic.

```sql
CREATE TABLE shots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx           int NOT NULL,                   -- ordering within the OP
  render_kind   render_kind NOT NULL,           -- preview vs final share rows? keep separate rows per kind
  character_id  uuid REFERENCES characters(id),
  start_ms      int NOT NULL,
  end_ms        int NOT NULL,
  prompt        jsonb NOT NULL,                 -- i2v inputs: ref image key, motion, model route
  status        stage_status NOT NULL DEFAULT 'pending',
  attempts      int NOT NULL DEFAULT 0,         -- capped (cost control)
  clip_r2_key   text,                           -- generated clip output
  reused_from   uuid REFERENCES shots(id),      -- clip reuse instead of regenerating
  error         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, render_kind, idx)
);
CREATE INDEX ON shots (project_id, render_kind, status);
```

### renders
The composed outputs. Preview (low-res, watermarked, free) and final (full-res, clean, charged).

```sql
CREATE TABLE renders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          render_kind NOT NULL,
  r2_key        text,                           -- final MP4
  watermarked   boolean NOT NULL,
  duration_ms   int,
  charged       boolean NOT NULL DEFAULT false, -- true only for a billed final encode
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind)
);
```

### job_runs
Per-stage execution log — the durable status the UI reads and the audit trail for retries. One row per stage attempt.

```sql
CREATE TABLE job_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage         stage_name NOT NULL,
  status        stage_status NOT NULL DEFAULT 'pending',
  attempt       int NOT NULL DEFAULT 1,
  started_at    timestamptz,
  finished_at   timestamptz,
  error         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON job_runs (project_id, stage, created_at DESC);
```

### credit_ledger
Append-only ledger. Balance = sum of `delta`. The **only** negative entry tied to generation is `charge_final`, written transactionally with the final encode. Never write a charge for previews or for internal retries.

```sql
CREATE TABLE credit_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  delta         int NOT NULL,                   -- + grant/purchase/refund, - charge
  reason        ledger_reason NOT NULL,
  stripe_ref    text,                           -- payment intent / invoice id where relevant
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON credit_ledger (user_id, created_at DESC);
```

## Relationships at a glance

```
users 1───* projects 1───* assets
                      1───* consents        (versioned, append-only)
                      1───* characters       (cluster OR manual → identical shape)
                      1───1 music_tracks
                      1───1 storyboards 1──* shots ──* renders
                      1───* job_runs
users 1───* credit_ledger *───1 projects
```

## Idempotency notes for builders

- Re-running a stage must be safe. Guard with `job_runs` status + natural keys (`shots.UNIQUE(project_id, render_kind, idx)`, `renders.UNIQUE(project_id, kind)`).
- **Never double-charge.** `charge_final` is written in the same transaction that flips `renders.charged = true`; check `charged` before charging.
- Balances come from real Stripe purchases: the `checkout.session.completed` webhook writes a `purchase` row idempotently (keyed on the session id), and `charge_final` decrements the balance on final encode. Both sides of the ledger are append-only.

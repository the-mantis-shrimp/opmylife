# Gallery assets (persistent demo videos)

The `/gallery` (and homepage) demo videos are **marketing assets that must live
forever** — unlike user renders, which are encrypted, private, and auto-deleted
after the TTL window. So they are stored **separately** from user content:

- **NOT in git** — video binaries bloat the repo permanently (git keeps every
  version in history) and force a redeploy to change a clip.
- **NOT in the main R2 bucket** — that bucket has a lifecycle rule that deletes
  objects after `RENDER_TTL_HOURS`, which would wipe them.

They live in a **dedicated public R2 bucket with no lifecycle rule**, served over
a public URL, and referenced by the app via `GALLERY_ASSET_BASE_URL`.

## One-time setup

### 1. Create a dedicated public bucket
1. Cloudflare dashboard → **R2 → Create bucket**, e.g. `opmylife-public`.
2. **Do not** add any lifecycle/expiration rule to this bucket (that's the whole point).

### 2. Make it publicly readable
Pick one:
- **Custom domain (recommended):** bucket → **Settings → Public access → Custom Domains → Connect Domain**, e.g. `cdn.opmylife.com`. Cloudflare adds the DNS + serves it over HTTPS with CDN caching. Public base URL = `https://cdn.opmylife.com`.
- **r2.dev URL (quick):** bucket → **Settings → Public access → Allow Access (r2.dev)**. Public base URL = the `https://pub-<hash>.r2.dev` it gives you. (Fine for testing; a custom domain is nicer for production and branding.)

> Plain `<video src>` playback is cross-origin-safe and needs **no CORS** config. Only add CORS if you later read frames via JS/canvas.

### 3. Upload the demo files
Upload each clip (and an optional poster image with the same name + `.jpg`) to the
**bucket root**. **Titles are derived from the filename** — name files descriptively:

- `sample_New-Years-Abroad.mp4` → shows as **"New Years Abroad"**
- a leading `sample_` (or `sample-`) is stripped; `-`/`_` become spaces.
- Optional poster: `sample_New-Years-Abroad.jpg` (shows instantly while the video loads).

**Dynamic listing (recommended):** set `GALLERY_BUCKET` to the bucket name. The app
then lists the bucket, so **dropping a new video in makes it appear automatically** —
no code change. (The R2 API token must have read access to this bucket.)

**Without `GALLERY_BUCKET`:** the app uses the fallback filename list in
`lib/gallery.ts` (`FALLBACK_FILES`) — edit that array to match your files.

**Aspect ratio:** the cards render each video at **its own aspect ratio** (portrait
or landscape), so mixed orientations display correctly.

**Encoding tips** (these autoplay muted + loop as preview tiles):
- Keep them short and small — H.264 MP4, `+faststart` (so playback starts before full download), ~1–3 MB each.
- 9:16 (portrait) matches the tile aspect; a poster JPG shows instantly while the video loads.

### 4. Point the app at it
Set on the **web** service and redeploy:

```
GALLERY_ASSET_BASE_URL=https://cdn.opmylife.com
GALLERY_BUCKET=opmylife-public
```

When set, the gallery renders real muted/looping `<video>` tiles; when blank, it
falls back to gradient placeholders (so dev/preview stays runnable without the bucket).

## Notes
- These assets are **out of scope** for `cleanup.ttl` and the main bucket's lifecycle rule by construction (different bucket).
- Swapping a demo = re-upload the file to the bucket; no code change or redeploy needed (unless you change the filenames in `SAMPLES`).

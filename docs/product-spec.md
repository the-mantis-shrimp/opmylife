# Product Spec

## Summary

A web app that turns a user's **photo album + a song** into a **beat-synced, ~90-second anime opening** ("OP"). The user uploads photos of people they care about (themselves, friends, family, pets), picks or generates a track, and the app produces a stylized anime title sequence where their stylized characters appear in shots cut to the music — the way a real anime OP introduces its cast.

We are not training models. We are an **orchestration layer**: we sequence calls to third-party vision, image, image-to-video, and music APIs, stitch the results with ffmpeg/Remotion, and sell the generation + sync as a finished render. Users own their output and assume liability for any music they upload.

## Who it's for

Anime fans and gift-makers who want a personalized, shareable hype reel — birthday/anniversary gifts, friend-group intros, fan-style edits of themselves. The emotional hook is "see myself and my people as an anime cast."

## Core value

- **Personalized**: the cast is *your* people, stylized into anime characters with consistent identity across shots.
- **Synced**: cuts, title cards, and character reveals land on the beat — this is the part that makes it feel like a real OP, and it's the hard part we're selling.
- **Hands-off**: upload → wait → download. No editing skills required.

## The user journey (happy path)

1. **Sign in** (Clerk).
2. **Create a project.** Give it a title (used on the title card).
3. **Upload photos.** Direct browser→R2 presigned upload. App validates count/format/size/content.
4. **Consent step.** A distinct, separate biometric-consent checkbox decides the identity path:
   - **Consent granted** → automatic face clustering groups photos by person.
   - **Consent declined** → manual tagging: the user labels who's who. Same result downstream.
5. **Pick music.** Generate a track (Suno/Udio, the default) or opt in to upload their own (they accept liability).
6. **Generate a preview.** Cheap model, low-res, watermarked, **free**. The user sees the storyboard/style and a rough cut.
7. **Approve → final render.** Credits are charged **only here**, on final encode. High-quality i2v, full-res, no watermark.
8. **Download / share.** Delivered from R2. Inputs and outputs auto-delete server-side after a TTL window.

## Inputs & constraints

- **Photos**: common image formats (JPEG/PNG/WebP/HEIC), a sensible count range (enough faces to build a cast, capped to control cost). Validated at `ingest.validate`.
- **Music**: user-uploaded (liability accepted); the OP is cut to the track's beats. With no upload, the OP renders on a silent track of the chosen length. (Generated music via Suno/Udio is scaffolded but not the shipped path.)
- **Output**: ~90s MP4 (H.264/AAC), beat-synced, with a deterministic title card. Preview = low-res + watermark; final = full-res + clean.

## Scope

The product is **shipped and live**. The full pipeline runs end to end — ingest, consent, stylization, storyboard, beat-synced generation, assembly, and final encode — with the **consent gate + manual-tagging fallback built into the spine** from day one. Previews are free and watermarked; finals are billed on a token/credit model via **Stripe**. Photos stylize into three looks (**Anime / Pixar / Fantasy**), or the **Animate Me** mode composes the people from a user's photos into new scenes. The UI is bilingual (EN/ES).

See `build-plan.md` for how it was built, phase by phase, and the remaining backlog.

## Non-goals

- Not a general video editor; the user does not edit timelines.
- Not training or fine-tuning models.
- Not hosting GPUs — all heavy generation is offloaded to model APIs; our compute is CPU-only (ffmpeg/orchestration).
- Not claiming end-to-end encryption (see `privacy-and-consent.md`).
- Not a music library — the user brings their own track; we don't supply licensed catalog tracks.

## Product invariants (do not violate)

These are restated from `CLAUDE.md` because they shape the UX, not just the backend:

- The biometric-consent checkbox is **separate from ToS** and gates face processing. No consent → no face clustering, ever.
- Previews are free; **credits are charged only on final encode**.
- Deletion is **server-side on a TTL**, never tied to the browser session.
- Title typography is **rendered deterministically**, never by a video model.
- Privacy copy says **encryption at rest**, never "end-to-end."

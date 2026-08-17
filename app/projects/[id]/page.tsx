"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Mirror the server (env MAX_PHOTOS_PER_PROJECT, OP_LENGTH_MS). The 3-photo cap
// is ONLY for style references (see StyleRefsStep); the album is generous.
const MAX_PHOTOS = 30;
const OP_SECONDS = 15;

/** Trigger a file download via a transient anchor (URL already carries
 *  Content-Disposition: attachment, so it saves rather than navigating). */
function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * iPhone photos are HEIC, which browsers can't display and the model APIs can't
 * read. Convert to JPEG in the browser before upload so thumbnails render and the
 * pipeline works. Non-HEIC files pass through untouched; a conversion failure
 * falls back to the original (better to try than to hard-block the upload).
 */
async function maybeConvertHeic(file: File): Promise<File> {
  const isHeic = /image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  if (!isHeic) return file;
  try {
    const heic2any = (await import("heic2any")).default;
    const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    const blob = Array.isArray(out) ? out[0] : out;
    const name = file.name.replace(/\.(heic|heif)$/i, ".jpg");
    return new File([blob], name, { type: "image/jpeg" });
  } catch (err) {
    console.warn("HEIC → JPEG conversion failed; uploading original", err);
    return file;
  }
}

const SHARE_SITE = "https://opmylife.com";
const SHARE_TEXT = "Check out the animated album I made with OPmylife! 🎬";

/**
 * Quickshare: hand the actual video to the OS share sheet (mobile → Instagram,
 * TikTok, Messages, …). Falls back to the generic Web Share link, then a copied
 * link, on platforms that can't share files. Requires R2 CORS to allow GET from
 * this origin (so the video can be fetched as a Blob).
 */
async function shareVideo(url: string, filename: string) {
  // Best case: share the real video file.
  try {
    const res = await fetch(url);
    if (res.ok) {
      const blob = await res.blob();
      const file = new File([blob], filename, { type: blob.type || "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: `${SHARE_TEXT} ${SHARE_SITE}` });
        return;
      }
    }
  } catch {
    /* AbortError (user cancelled) or fetch/CORS issue → fall through to link share */
  }
  // Fallback: share just the generic link (desktop / no file-share support).
  if (navigator.share) {
    try {
      await navigator.share({ title: "OPmylife", text: SHARE_TEXT, url: SHARE_SITE });
      return;
    } catch {
      return; // user cancelled the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(`${SHARE_TEXT} ${SHARE_SITE}`);
    alert("Share link copied to clipboard!");
  } catch {
    alert(SHARE_SITE);
  }
}

/** PUT a file to a presigned URL with real upload-progress (fetch can't report it). */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(file);
  });
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="progress">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

type Photo = { id: string; url: string };
type Character = { id: string; label: string | null; source_asset_ids: string[]; ref_r2_key: string | null };

function ProjectTitle({ projectId, title, onChange }: { projectId: string; title: string; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(title), [title]);

  async function save() {
    const next = draft.trim();
    if (!next || next === title) return setEditing(false);
    setBusy(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    setBusy(false);
    setEditing(false);
    onChange();
  }

  if (!editing) {
    return (
      <h1 className="row" style={{ gap: 10, alignItems: "center" }}>
        {title}
        <button
          type="button"
          className="link-danger"
          style={{ fontWeight: 500 }}
          onClick={() => setEditing(true)}
          title="Rename project"
        >
          Rename
        </button>
      </h1>
    );
  }

  return (
    <div className="row" style={{ gap: 8 }}>
      <input
        type="text"
        value={draft}
        autoFocus
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
      />
      <button type="button" onClick={save} disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setDraft(title);
          setEditing(false);
        }}
      >
        Cancel
      </button>
    </div>
  );
}

export default function ProjectPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [status, setStatus] = useState<any>(null);
  const [renderKind, setRenderKind] = useState<"preview" | "final">("preview");
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}?renderKind=${renderKind}`);
    if (res.ok) setStatus(await res.json());
  }, [projectId, renderKind]);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 2500);
    return () => clearInterval(t);
  }, [loadStatus]);

  const project = status?.project;
  // NOTE: the status API (lib/projects.projectStatus) returns camelCase fields.
  const identityPath: string | null = project?.identityPath ?? null;

  return (
    <div className="themed">
      <p className="small">
        <a href="/dashboard">← All projects</a>
      </p>
      <div className="row spread">
        <ProjectTitle projectId={projectId} title={project?.title ?? "Project"} onChange={loadStatus} />
        <span className="badge">{project?.status ?? "…"}</span>
      </div>

      {error && <p className="err">{error}</p>}

      {/* Photos + music first — the two things every project needs. */}
      <UploadStep projectId={projectId} onChange={loadStatus} />
      <MusicStep projectId={projectId} onChange={loadStatus} setError={setError} />

      {/* Consent (+ manual tagging only on the no-consent path). */}
      <ConsentStep projectId={projectId} identityPath={identityPath} onChange={loadStatus} setError={setError} />
      {identityPath === "manual" && <ManualTagStep projectId={projectId} onChange={loadStatus} setError={setError} />}

      {/* The look: main choices up top; power-user title/model options tucked away. */}
      <StyleStep projectId={projectId} style={project?.style ?? "original"} onChange={loadStatus} />
      {project?.style === "reference" && <StyleRefsStep projectId={projectId} onChange={loadStatus} />}
      <ModeStep
        projectId={projectId}
        mode={project?.mode ?? "album-to-life"}
        direction={project?.direction ?? ""}
        onChange={loadStatus}
      />

      <TitleCardStep
        projectId={projectId}
        title={project?.title ?? ""}
        titleCardText={project?.titleCardText ?? ""}
        transition={project?.titleTransition ?? "cut"}
        onChange={loadStatus}
      />

      <details className="advanced">
        <summary>Advanced options — AI models</summary>
        <ImageModelStep projectId={projectId} imageModel={project?.imageModel ?? "nano-banana-pro"} onChange={loadStatus} />
        <VideoModelStep projectId={projectId} videoModel={project?.videoModel ?? "kling-3-pro"} onChange={loadStatus} />
      </details>

      <SubmitStep
        projectId={projectId}
        identityPath={identityPath}
        musicConfirmed={!!project?.musicSource}
        estimate={status?.estimate}
        previewQuota={status?.previewQuota}
        renderKind={renderKind}
        setRenderKind={setRenderKind}
        motionCaveatStyle={
          project?.style === "anime" ? "Anime" : project?.style === "fantasy" ? "Fantasy" : null
        }
        onChange={loadStatus}
        setError={setError}
      />
      <ProgressStep status={status} renderKind={renderKind} projectId={projectId} onChange={loadStatus} />
      <HistoryStep projectId={projectId} refreshSignal={project?.status ?? ""} expiresAt={project?.expiresAt ?? null} />
    </div>
  );
}

type UploadPhoto = { id: string; url: string; position: number };

function UploadStep({ projectId, onChange }: { projectId: string; onChange: () => void }) {
  const [photos, setPhotos] = useState<UploadPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/photos`);
    if (res.ok) setPhotos((await res.json()).photos ?? []);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const picked = Array.from(files).slice(0, Math.max(0, MAX_PHOTOS - photos.length));
    if (picked.length === 0) return;
    setBusy(true);
    // Convert iPhone HEIC → JPEG in the browser first, so everything downstream
    // (presign, thumbnails, model APIs) sees a readable format.
    const arr = await Promise.all(picked.map(maybeConvertHeic));
    const res = await fetch(`/api/projects/${projectId}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: arr.map((f) => ({ filename: f.name, contentType: f.type || "image/jpeg", kind: "photo", bytes: f.size })),
      }),
    });
    if (res.ok) {
      const { uploads } = await res.json();
      const prog = new Array(arr.length).fill(0);
      setProgress(0);
      await Promise.all(
        uploads.map((u: any, i: number) =>
          putWithProgress(u.uploadUrl, arr[i], arr[i].type || "image/jpeg", (pct) => {
            prog[i] = pct;
            setProgress(Math.round(prog.reduce((a, b) => a + b, 0) / prog.length));
          }),
        ),
      );
    }
    setProgress(null);
    setBusy(false);
    await load();
    onChange();
  }

  async function remove(id: string) {
    setPhotos((ps) => ps.filter((p) => p.id !== id)); // optimistic
    await fetch(`/api/projects/${projectId}/photos/${id}`, { method: "DELETE" });
    onChange();
  }

  async function persistOrder(next: UploadPhoto[]) {
    setPhotos(next);
    await fetch(`/api/projects/${projectId}/photos`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: next.map((p) => p.id) }),
    });
  }

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const from = photos.findIndex((p) => p.id === dragId);
    const to = photos.findIndex((p) => p.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...photos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDragId(null);
    persistOrder(next);
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>1 · Photos</h2>
      <p className="muted small">
        Up to <strong>{MAX_PHOTOS} photos</strong> of the people you want in the OP. Drag to reorder, hover a photo to
        delete.
      </p>
      <p className="muted small" style={{ marginTop: -4 }}>
        📐 For the best framing, use photos with the <strong>same orientation as your video</strong> (portrait vs.
        landscape). Mismatched photos are letterboxed with black bars so the subject isn’t cropped.
      </p>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 12 }}>
        JPEG, PNG, and <strong>HEIC (iPhone)</strong> all work — HEIC photos are converted automatically.
      </p>
      <input
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => upload(e.target.files)}
        disabled={busy || photos.length >= MAX_PHOTOS}
      />
      {photos.length >= MAX_PHOTOS && (
        <p className="small muted" style={{ marginTop: 8 }}>Maximum {MAX_PHOTOS} photos reached — delete one to add another.</p>
      )}

      {photos.length > 0 && (
        <>
          <p className="small muted" style={{ marginTop: 12 }}>
            {photos.length}/{MAX_PHOTOS} photo{photos.length === 1 ? "" : "s"} · drag to reorder
          </p>
          <div className="thumbs" style={{ marginTop: 6 }}>
            {photos.map((p, i) => (
              <div
                key={p.id}
                className="photo-tile"
                draggable
                onDragStart={() => setDragId(p.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDrop(p.id)}
                style={{ opacity: dragId === p.id ? 0.4 : 1 }}
                title="Drag to reorder"
              >
                <img src={p.url} alt="" />
                <span className="photo-index">{i + 1}</span>
                <button
                  type="button"
                  className="photo-del"
                  onClick={() => remove(p.id)}
                  title="Delete photo"
                  aria-label="Delete photo"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {progress !== null && (
        <>
          <ProgressBar pct={progress} />
          <p className="small muted">Uploading… {progress}%</p>
        </>
      )}
    </div>
  );
}

function ConsentStep({
  projectId,
  identityPath,
  onChange,
  setError,
}: {
  projectId: string;
  identityPath: string | null;
  onChange: () => void;
  setError: (s: string | null) => void;
}) {
  const [tos, setTos] = useState(false);
  const [bio, setBio] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tosAccepted: tos, biometricGranted: bio }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error);
      return;
    }
    onChange();
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>3 · Consent</h2>
      {identityPath ? (
        <p className="small">
          Decision recorded · identity path: <strong>{identityPath}</strong>{" "}
          {identityPath === "cluster" ? "(automatic face clustering)" : "(manual tagging)"}
        </p>
      ) : (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={tos} onChange={(e) => setTos(e.target.checked)} />
            <span>
              I accept the <a href="/legal/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> and{" "}
              <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>, and I confirm I have
              the rights to the photos and music I upload and the consent of anyone shown. Photos are{" "}
              <strong>encrypted at rest</strong> and processed by third-party AI providers to generate the video;
              inputs/outputs auto-delete after the TTL window.
            </span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={bio} onChange={(e) => setBio(e.target.checked)} />
            <span>
              <strong>Separate, optional:</strong> I consent to automatic <strong>biometric face clustering</strong>{" "}
              to group photos by person. If unchecked, you'll tag people manually — no face processing happens.
            </span>
          </label>
          <button onClick={save} disabled={busy || !tos}>
            {busy ? "Saving…" : "Save consent"}
          </button>
        </>
      )}
    </div>
  );
}

function ManualTagStep({
  projectId,
  onChange,
  setError,
}: {
  projectId: string;
  onChange: () => void;
  setError: (s: string | null) => void;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [chars, setChars] = useState<Character[]>([]);
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{ label: string; assetIds: string[] }[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/characters`);
    if (res.ok) {
      const d = await res.json();
      setPhotos(d.photos ?? []);
      setChars(d.characters ?? []);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function addCharacter() {
    if (!label.trim() || selected.size === 0) return;
    setDraft((d) => [...d, { label: label.trim(), assetIds: Array.from(selected) }]);
    setLabel("");
    setSelected(new Set());
  }

  async function saveAll() {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characters: draft }),
    });
    if (!res.ok) {
      setError((await res.json()).error);
      return;
    }
    setDraft([]);
    await load();
    onChange();
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>3 · Tag people (manual path)</h2>
      <p className="muted small">No biometric consent → label who's who. Select photos, name the character, add.</p>
      <div className="thumbs">
        {photos.map((p) => (
          <div key={p.id} className={`thumb${selected.has(p.id) ? " sel" : ""}`} onClick={() => toggle(p.id)}>
            <img src={p.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 6 }} />
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <input type="text" placeholder="Character name (e.g. Mom)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="secondary" onClick={addCharacter} disabled={!label.trim() || selected.size === 0}>
          Add character ({selected.size} photos)
        </button>
      </div>

      {draft.length > 0 && (
        <ul className="clean">
          {draft.map((c, i) => (
            <li key={i}>
              <strong>{c.label}</strong> · {c.assetIds.length} photos
            </li>
          ))}
        </ul>
      )}
      {draft.length > 0 && <button onClick={saveAll}>Save {draft.length} character(s)</button>}

      {chars.length > 0 && (
        <p className="small" style={{ marginTop: 12 }}>
          Saved: {chars.map((c) => c.label).join(", ")}
        </p>
      )}
    </div>
  );
}

function StyleStep({ projectId, style, onChange }: { projectId: string; style: string; onChange: () => void }) {
  const [local, setLocal] = useState(style);
  const [busy, setBusy] = useState(false);
  useEffect(() => setLocal(style), [style]);

  async function save(v: string) {
    setLocal(v);
    setBusy(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ style: v }),
    });
    setBusy(false);
    onChange();
  }

  const blurb: Record<string, string> = {
    original: "Keep everyone's real, photographic look — just animated (no restyling).",
    pixar: "Render your people as 3D cartoon characters (CGI animated-movie style).",
    anime: "Render your people as 2D anime characters.",
    fantasy: "Repaint your people as epic fantasy characters (painterly, magical illustration).",
    reference: "Define your own look from uploaded style reference images (see below).",
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>4 · Style</h2>
      <p className="muted small">How your people are rendered in the video.</p>
      <select className="select" value={local} onChange={(e) => save(e.target.value)} disabled={busy}>
        <option value="original">Original (unaltered)</option>
        <option value="pixar">3D Cartoon</option>
        <option value="anime">Anime</option>
        <option value="fantasy">Fantasy</option>
        <option value="reference">Custom (from style references)</option>
      </select>
      <p className="small muted" style={{ marginTop: 8 }}>
        {blurb[local]}
      </p>
    </div>
  );
}

type StyleRef = { id: string; url: string };

function StyleRefsStep({ projectId, onChange }: { projectId: string; onChange: () => void }) {
  const [refs, setRefs] = useState<StyleRef[]>([]);
  const [max, setMax] = useState(3);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/style-refs`);
    if (res.ok) {
      const d = await res.json();
      setRefs(d.styleRefs ?? []);
      setMax(d.max ?? 3);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const arr = Array.from(files).slice(0, max - refs.length);
    if (arr.length === 0) return;
    setBusy(true);
    const res = await fetch(`/api/projects/${projectId}/style-refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: arr.map((f) => ({ filename: f.name, contentType: f.type || "image/jpeg", bytes: f.size })),
      }),
    });
    if (res.ok) {
      const { uploads } = await res.json();
      await Promise.all(
        uploads.map((u: any, i: number) =>
          fetch(u.uploadUrl, { method: "PUT", headers: { "content-type": arr[i].type || "image/jpeg" }, body: arr[i] }),
        ),
      );
    }
    setBusy(false);
    await load();
    onChange();
  }

  async function remove(id: string) {
    setRefs((r) => r.filter((x) => x.id !== id)); // optimistic
    await fetch(`/api/projects/${projectId}/style-refs/${id}`, { method: "DELETE" });
    onChange();
  }

  const full = refs.length >= max;

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Style references</h2>
      <p className="muted small">
        Upload 1–{max} images that define the look — the stylizer matches their art style (linework, colors, shading).
        For a consistent result, use references that share one coherent style.
      </p>
      {refs.length === 0 && (
        <p className="small callout" style={{ marginBottom: 12 }}>
          Add at least one reference image — the Custom style has nothing to match without one.
        </p>
      )}
      <input
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => upload(e.target.files)}
        disabled={busy || full}
      />
      {full && <p className="small muted" style={{ marginTop: 8 }}>Maximum {max} reached — delete one to add another.</p>}
      {refs.length > 0 && (
        <div className="thumbs" style={{ marginTop: 12 }}>
          {refs.map((r) => (
            <div key={r.id} className="photo-tile" style={{ cursor: "default" }}>
              <img src={r.url} alt="" />
              <button
                type="button"
                className="photo-del"
                onClick={() => remove(r.id)}
                title="Delete style reference"
                aria-label="Delete style reference"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {busy && <p className="small">Uploading…</p>}
    </div>
  );
}

function ModeStep({
  projectId,
  mode,
  direction,
  onChange,
}: {
  projectId: string;
  mode: string;
  direction: string;
  onChange: () => void;
}) {
  const [localMode, setLocalMode] = useState(mode);
  const [localDirection, setLocalDirection] = useState(direction);
  const [busy, setBusy] = useState(false);
  const [savedDirection, setSavedDirection] = useState(direction);
  useEffect(() => setLocalMode(mode), [mode]);
  useEffect(() => {
    setLocalDirection(direction);
    setSavedDirection(direction);
  }, [direction]);

  async function saveMode(v: string) {
    setLocalMode(v);
    setBusy(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: v }),
    });
    setBusy(false);
    onChange();
  }

  async function saveDirection() {
    setBusy(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: localDirection }),
    });
    setSavedDirection(localDirection);
    setBusy(false);
    onChange();
  }

  const blurb: Record<string, string> = {
    "album-to-life": "Every uploaded photo becomes exactly one shot, used once, in upload order.",
    "animate-me": "People are extracted from your photos and can appear — and repeat — across multiple shots.",
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>5 · Mode</h2>
      <p className="muted small">How your photos are turned into shots.</p>
      <select className="select" value={localMode} onChange={(e) => saveMode(e.target.value)} disabled={busy}>
        <option value="album-to-life">Album to Life</option>
        <option value="animate-me">Animate Me</option>
      </select>
      <p className="small muted" style={{ marginTop: 8 }}>
        {blurb[localMode]}
      </p>

      {localMode === "animate-me" && (
        <div style={{ marginTop: 10 }}>
          <label className="small" style={{ display: "block", marginBottom: 4 }}>
            Video direction <span className="muted">(optional — tell the director what you want)</span>
          </label>
          <textarea
            className="select"
            style={{ width: "100%", minHeight: 70, resize: "vertical", fontFamily: "inherit" }}
            placeholder="e.g. Make it feel like a road-trip montage, high energy, lots of quick cuts on the chorus…"
            value={localDirection}
            onChange={(e) => setLocalDirection(e.target.value)}
            maxLength={2000}
          />
          <div className="row" style={{ marginTop: 6 }}>
            <button
              type="button"
              onClick={saveDirection}
              disabled={busy || localDirection === savedDirection}
            >
              Save direction
            </button>
            {localDirection !== savedDirection && <span className="small muted">unsaved changes</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function TitleCardStep({
  projectId,
  title,
  titleCardText,
  transition,
  onChange,
}: {
  projectId: string;
  title: string;
  titleCardText: string;
  transition: string;
  onChange: () => void;
}) {
  const [text, setText] = useState(titleCardText);
  const [savedText, setSavedText] = useState(titleCardText);
  const [localTransition, setLocalTransition] = useState(transition);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setText(titleCardText);
    setSavedText(titleCardText);
  }, [titleCardText]);
  useEffect(() => setLocalTransition(transition), [transition]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    onChange();
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Title card</h2>

      <label className="small" style={{ display: "block", marginBottom: 4 }}>
        Title card &amp; transition
      </label>
      <select
        className="select"
        value={localTransition}
        onChange={(e) => {
          setLocalTransition(e.target.value);
          patch({ titleTransition: e.target.value });
        }}
        disabled={busy}
      >
        <option value="none">No title card</option>
        <option value="cut">Cut (hard)</option>
        <option value="fade-in">Fade in from black</option>
        <option value="fade-over">Fade over the first shot</option>
      </select>

      {localTransition !== "none" && (
        <>
          <label className="small" style={{ display: "block", margin: "12px 0 4px" }}>
            Title text <span className="muted">(defaults to the project title{title ? `: "${title}"` : ""})</span>
          </label>
          <div className="row">
            <input
              type="text"
              placeholder={title || "Your title"}
              value={text}
              maxLength={120}
              onChange={(e) => setText(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="secondary"
              disabled={busy || text === savedText}
              onClick={() => patch({ titleCardText: text })}
            >
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ImageModelStep({
  projectId,
  imageModel,
  onChange,
}: {
  projectId: string;
  imageModel: string;
  onChange: () => void;
}) {
  const [local, setLocal] = useState(imageModel);
  const [busy, setBusy] = useState(false);
  useEffect(() => setLocal(imageModel), [imageModel]);

  async function save(v: string) {
    setLocal(v);
    setBusy(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageModel: v }),
    });
    setBusy(false);
    onChange();
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Stylization model</h2>
      <p className="muted small">
        Which AI model redraws your photos into the chosen style. If the result still looks too photographic,
        try a stronger one. Changing this re-stylizes all photos on the next generate.
      </p>
      <select className="select" value={local} onChange={(e) => save(e.target.value)} disabled={busy}>
        <option value="nano-banana-pro">Nano Banana Pro — stronger stylization</option>
        <option value="nano-banana">Nano Banana — fast, subtle</option>
        <option value="gemini-flash">Gemini 2.5 Flash Image</option>
        <option value="flux-kontext">FLUX.1 Kontext Pro — best for real photos</option>
      </select>
      <p className="small muted" style={{ marginTop: 6 }}>
        Tip: the Nano Banana / Gemini models sometimes refuse to restyle real photos of people. FLUX.1 Kontext doesn’t —
        the app also switches to it automatically if a Gemini model blocks a photo.
      </p>
    </div>
  );
}

function VideoModelStep({
  projectId,
  videoModel,
  onChange,
}: {
  projectId: string;
  videoModel: string;
  onChange: () => void;
}) {
  const [local, setLocal] = useState(videoModel);
  const [busy, setBusy] = useState(false);
  useEffect(() => setLocal(videoModel), [videoModel]);

  async function save(v: string) {
    setLocal(v);
    setBusy(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoModel: v }),
    });
    setBusy(false);
    onChange();
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Video model</h2>
      <p className="muted small">
        Which AI model generates the shots. Premium models cost more per second. <strong>Applies to final renders
        only</strong> — previews always use a cheap model to keep drafts free.
      </p>
      <select className="select" value={local} onChange={(e) => save(e.target.value)} disabled={busy}>
        <option value="kling-3-pro">Kling v3 Pro — high quality</option>
        <option value="kling-2.1">Kling 2.1 Standard — fast, cheap</option>
        <option value="veo-3.1">Google Veo 3.1 — premium</option>
      </select>
    </div>
  );
}

function MusicStep({
  projectId,
  onChange,
  setError,
}: {
  projectId: string;
  onChange: () => void;
  setError: (s: string | null) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [mode, setMode] = useState<"upload" | "silent">("upload");
  const [silentSec, setSilentSec] = useState(30);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(30);
  const [liability, setLiability] = useState(false);
  const [busy, setBusy] = useState(false);
  // True when the current start/stop, length, song, or mode differs from what was
  // last saved — i.e. the user must re-click Save for the changes to take effect.
  const [dirty, setDirty] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewUntil = useRef<number | null>(null); // stop time (s) for selection playback

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/music`);
    if (!res.ok) return;
    const d = await res.json();
    setData(d);
    if (d.musicSource === "generated") setMode("silent");
    if (d.silentLengthMs) setSilentSec(Math.round(d.silentLengthMs / 1000));
    if (d.track) {
      setPreviewUrl(d.track.previewUrl);
      if (d.track.duration_ms) setDurationSec(Math.round(d.track.duration_ms / 1000));
      setStartSec(Math.round((d.track.window?.startMs ?? 0) / 1000));
      setEndSec(Math.round((d.track.window?.endMs ?? 30000) / 1000));
      setLiability(d.liabilityAccepted === true);
    }
    setDirty(false); // loaded state matches what's saved
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function uploadFile(file: File) {
    setBusy(true);
    setError(null);
    // 1) presign + create the music_upload asset, 2) PUT bytes directly to storage.
    const presign = await fetch(`/api/projects/${projectId}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ filename: file.name, contentType: file.type || "audio/mpeg", kind: "music_upload", bytes: file.size }],
      }),
    });
    const { uploads } = await presign.json();
    const up = uploads[0];
    setUploadPct(0);
    await putWithProgress(up.uploadUrl, file, file.type || "audio/mpeg", setUploadPct);
    setUploadPct(null);
    setAssetId(up.assetId);
    setDirty(true); // a newly uploaded song isn't saved to the project until "Save"

    // Read the real duration client-side so the user can pick a sensible window.
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    const audio = new Audio(url);
    audio.addEventListener("loadedmetadata", () => {
      const dur = Math.floor(audio.duration);
      setDurationSec(dur);
      setStartSec(0);
      setEndSec(Math.min(dur, 30));
    });
    setBusy(false);
  }

  // Play the selected window [start, end] on the audio element.
  function playSelection() {
    const el = audioRef.current;
    if (!el) return;
    previewUntil.current = endSec;
    el.currentTime = startSec;
    el.play();
  }
  function onAudioTime() {
    const el = audioRef.current;
    if (el && previewUntil.current != null && el.currentTime >= previewUntil.current) {
      el.pause();
      previewUntil.current = null;
    }
  }

  async function saveUploaded() {
    const trimStartMs = Math.round(startSec * 1000);
    const trimEndMs = Math.round(endSec * 1000);
    setBusy(true);
    setError(null);
    let res: Response;
    if (assetId) {
      // A song was uploaded THIS session → full save with the new asset.
      res = await fetch(`/api/projects/${projectId}/music`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "uploaded",
          assetId,
          liabilityAccepted: true,
          durationMs: durationSec ? durationSec * 1000 : undefined,
          trimStartMs,
          trimEndMs,
        }),
      });
    } else if (data?.track?.source === "uploaded") {
      // Adjusting the window of the already-saved track (assetId isn't in state
      // after a reload) → PATCH just the start/stop.
      res = await fetch(`/api/projects/${projectId}/music`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trimStartMs, trimEndMs }),
      });
    } else {
      setBusy(false);
      return setError("Upload a track first.");
    }
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error);
    onChange();
    load();
  }

  async function saveSilent() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/music`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "generated", silentLengthMs: Math.round(silentSec * 1000) }),
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error);
    onChange();
    load();
  }

  // The final uses the whole start→stop window; the preview uses only its first
  // OP_SECONDS. Window must be ≥ OP_SECONDS, up to the full song length.
  const windowSec = endSec - startSec;
  const windowOk = windowSec >= OP_SECONDS;

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>2 · Music</h2>
      <div className="row">
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={mode === "upload"} onChange={() => { setMode("upload"); setDirty(true); }} /> Upload a song
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={mode === "silent"} onChange={() => { setMode("silent"); setDirty(true); }} /> No music (silent)
        </label>
      </div>

      {mode === "silent" ? (
        <div style={{ marginTop: 12 }}>
          <p className="muted small">
            Your video will be <strong>silent</strong>. Choose its length ({OP_SECONDS}s–120s) — the preview still uses
            only the first {OP_SECONDS}s.
          </p>
          <label className="slider-row small">
            <span>Length</span>
            <input type="range" min={OP_SECONDS} max={120} value={silentSec} onChange={(e) => { setSilentSec(Number(e.target.value)); setDirty(true); }} />
            <span className="mono">{fmt(silentSec)}</span>
          </label>
          <button onClick={saveSilent} disabled={busy}>Save silent video</button>
          {dirty ? (
            <p className="small callout" style={{ marginTop: 8 }}>
              ⚠ Unsaved change — click <strong>Save silent video</strong> for the new length to take effect.
            </p>
          ) : data?.musicSource === "generated" ? (
            <p className="small" style={{ marginTop: 8 }}>Saved silent video ✓</p>
          ) : null}
        </div>
      ) : (
      <div style={{ marginTop: 10 }}>
          <p className="muted small">
            Upload a track and pick the <strong>start and stop</strong> points. The final uses your whole selection; the{" "}
            <strong>preview uses only the first {OP_SECONDS}s</strong>. You accept liability for rights to any track you
            upload.
          </p>
          <input type="file" accept="audio/*" onChange={(e) => e.target.files && uploadFile(e.target.files[0])} disabled={busy} />
          {uploadPct !== null && (
            <>
              <ProgressBar pct={uploadPct} />
              <p className="small muted">Uploading… {uploadPct}%</p>
            </>
          )}
          {previewUrl && (
            <audio
              ref={audioRef}
              src={previewUrl}
              controls
              onTimeUpdate={onAudioTime}
              style={{ display: "block", marginTop: 10, width: "100%" }}
            />
          )}

          {durationSec !== null && (
            <div style={{ marginTop: 12 }}>
              <p className="small muted">Track length: {fmt(durationSec)}. Drag the start and stop points (min {OP_SECONDS}s, up to the whole song).</p>

              <label className="slider-row small">
                <span>Start</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, durationSec - 1)}
                  value={startSec}
                  onChange={(e) => { setStartSec(Math.min(Number(e.target.value), endSec - 1)); setDirty(true); }}
                />
                <span className="mono">{fmt(startSec)}</span>
              </label>

              <label className="slider-row small">
                <span>Stop</span>
                <input
                  type="range"
                  min={1}
                  max={durationSec}
                  value={endSec}
                  onChange={(e) => { setEndSec(Math.max(Number(e.target.value), startSec + 1)); setDirty(true); }}
                />
                <span className="mono">{fmt(endSec)}</span>
              </label>

              <div className="row" style={{ marginTop: 6 }}>
                <button type="button" className="secondary" onClick={playSelection}>
                  ▶ Preview selection
                </button>
                <span className={`small ${windowOk ? "muted" : "err"}`}>
                  selection = {fmt(startSec)} → {fmt(endSec)} ({windowSec}s
                  {windowOk ? ` · preview uses first ${OP_SECONDS}s` : ` — must be at least ${OP_SECONDS}s`})
                </span>
              </div>

              <label className="checkbox">
                <input type="checkbox" checked={liability} onChange={(e) => setLiability(e.target.checked)} />
                <span className="small">I have the rights to this track and accept liability for its use.</span>
              </label>
              <button onClick={saveUploaded} disabled={busy || !liability || !windowOk}>
                Save music + selection
              </button>
              {dirty ? (
                <p className="small callout" style={{ marginTop: 8 }}>
                  ⚠ Unsaved changes — click <strong>Save music + selection</strong> for a new song, start/stop point, or
                  length to take effect.
                </p>
              ) : data?.track?.source === "uploaded" ? (
                <p className="small" style={{ marginTop: 8 }}>Saved uploaded track ✓</p>
              ) : null}
            </div>
          )}
      </div>
      )}
    </div>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type HistoryEntry = {
  id: string;
  kind: string;
  watermarked: boolean;
  hd: boolean;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  charged: boolean;
  createdAt: string;
  url: string | null;
  downloadUrl: string | null;
};

function HistoryStep({
  projectId,
  refreshSignal,
  expiresAt,
}: {
  projectId: string;
  refreshSignal: string;
  expiresAt: string | null;
}) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/history`);
    if (res.ok) setHistory((await res.json()).history ?? []);
  }, [projectId]);

  // Reload on mount and whenever a render finishes (project status changes).
  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>History</h2>
      <p className="muted small">
        Every render is saved here, so re-generating never loses one you liked. Play or download any past result.
      </p>
      {history.length > 0 && (
        <p className="small callout" style={{ marginBottom: 12 }}>
          ⚠ These are <strong>auto-deleted {fmtExpiry(expiresAt) ?? "after 3 days"}</strong>. Download anything you
          want to keep — deletion is permanent.
        </p>
      )}

      {history.length === 0 ? (
        <p className="small muted">No renders yet — generate a preview and it'll appear here.</p>
      ) : (
        <ul className="clean">
          {history.map((h) => (
            <li key={h.id}>
              <div className="row spread" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                    <span className="badge">{h.kind}</span>
                    {h.watermarked && <span className="badge">watermarked</span>}
                    {h.charged && <span className="badge">charged</span>}
                    <span className="small muted">
                      {h.durationMs ? fmt(h.durationMs / 1000) : ""} · {new Date(h.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {h.url && (
                    <video src={h.url} controls preload="metadata" style={{ width: "100%", maxWidth: 360, borderRadius: 8, background: "#000" }} />
                  )}
                </div>
                {(h.downloadUrl || h.url) && (
                  <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                    <a href={h.downloadUrl ?? h.url ?? undefined} download className="badge" style={{ cursor: "pointer" }}>
                      Download
                    </a>
                    {h.url && (
                      <button
                        className="badge"
                        style={{ cursor: "pointer" }}
                        onClick={() => shareVideo(h.url!, `opmylife-${h.kind}.mp4`)}
                      >
                        Share
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Estimate = {
  currency: string;
  low: number;
  high: number;
  shots: number;
  stylizations: number;
  videoSeconds: number;
  premiumVideo: boolean;
  finalTokens: number;
  breakdown: { label: string; cost: number }[];
  note?: string;
};

function SubmitStep({
  projectId,
  identityPath,
  musicConfirmed,
  estimate,
  renderKind,
  setRenderKind,
  motionCaveatStyle,
  previewQuota,
  onChange,
  setError,
}: {
  projectId: string;
  identityPath: string | null;
  musicConfirmed: boolean;
  estimate?: Estimate;
  renderKind: "preview" | "final";
  setRenderKind: (k: "preview" | "final") => void;
  motionCaveatStyle: string | null;
  previewQuota?: { used: number; remaining: number; limit: number };
  onChange: () => void;
  setError: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const outOfPreviews = !!previewQuota && previewQuota.remaining <= 0;

  async function submit(kind: "preview" | "final") {
    // Music is optional — warn once that without a track the video is silent.
    if (!musicConfirmed && !confirm("No music added — the video will be silent. Continue?")) {
      return;
    }
    setBusy(true);
    setError(null);
    setRenderKind(kind);
    try {
      const res = await fetch(`/api/projects/${projectId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ renderKind: kind }),
      });
      if (!res.ok) {
        // Body may be non-JSON (e.g. a 502 HTML page while the web service is
        // redeploying) — don't assume JSON, and give an actionable message.
        const msg = await res.json().catch(() => null);
        setError(
          msg?.error ??
            `Couldn't start the render (server ${res.status}). The app may be redeploying — try again in a moment.`,
        );
        return;
      }
      onChange();
    } catch {
      // fetch threw → server unreachable (likely mid-redeploy). Don't leave the
      // button stuck; the durable queue means nothing was lost — just retry.
      setError("Couldn't reach the server — it may be redeploying. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>6 · Generate</h2>
      <p className="muted small">
        Preview is free + watermarked. Generating a final spends tokens —{" "}
        <strong>all sales are final (non-refundable)</strong>.
      </p>
      {!musicConfirmed && (
        <p className="small callout" style={{ marginBottom: 12 }}>
          ⚠ No music added — the video will be <strong>silent</strong>. Upload a track in step 2 to add music.
        </p>
      )}

      {/* Free-preview tracker: remaining count + a depletion bar. Only previews
          that finish successfully count — failed ones don't. */}
      {previewQuota && (
        <div className="row spread small" style={{ margin: "0 0 12px" }}>
          <span className="muted">Free previews</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {previewQuota.remaining} of {previewQuota.limit} left
          </span>
        </div>
      )}
      {outOfPreviews && (
        <p className="small callout" style={{ marginBottom: 12 }}>
          You've used all {previewQuota!.limit} free previews. Switch to <strong>Final</strong> to keep generating.
        </p>
      )}

      {/* Choose what to generate, then generate. */}
      <div className="row" style={{ gap: 16, margin: "8px 0 12px" }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={renderKind === "preview"} onChange={() => setRenderKind("preview")} /> Preview
          (free, watermarked)
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={renderKind === "final"} onChange={() => setRenderKind("final")} /> Final (spends
          tokens)
        </label>
      </div>

      <div className="panel" style={{ background: "var(--panel-2)", margin: "0 0 12px" }}>
        {renderKind === "preview" ? (
          <>
            <div className="row spread">
              <strong>Estimated cost</strong>
              <strong style={{ color: "var(--green)" }}>Free</strong>
            </div>
            {motionCaveatStyle && (
              <p className="small muted" style={{ margin: "6px 0 0" }}>
                {motionCaveatStyle} previews use a lighter model, so motion looks flatter. The final render moves
                noticeably more.
              </p>
            )}
          </>
        ) : estimate ? (
          <>
            <div className="row spread">
              <strong>Estimated final cost</strong>
              <strong style={{ color: "var(--green)", fontVariantNumeric: "tabular-nums" }}>
                {estimate.finalTokens} tokens
              </strong>
            </div>
          </>
        ) : (
          <span className="small muted">Estimating…</span>
        )}
      </div>

      <div className="row">
        <button
          onClick={() => submit(renderKind)}
          disabled={busy || !identityPath || (renderKind === "preview" && outOfPreviews)}
        >
          {busy
            ? "Generating…"
            : renderKind === "preview"
              ? outOfPreviews
                ? "No free previews left"
                : "Generate preview"
              : "Generate final"}
        </button>
      </div>
      {!identityPath && <p className="small muted">Complete the consent step first.</p>}
    </div>
  );
}

function ProgressStep({
  status,
  renderKind,
  projectId,
  onChange,
}: {
  status: any;
  renderKind: "preview" | "final";
  projectId: string;
  onChange: () => void;
}) {
  // ── All hooks run unconditionally, BEFORE any early return (rules of hooks). ──
  const [cancelling, setCancelling] = useState(false);
  // Presigned URLs are re-signed (new query string) on EVERY poll even for the
  // same file. Binding <video src> straight to that resets playback every 2.5s.
  // Only adopt a new URL when the underlying object path actually changes.
  const [stableRenderUrl, setStableRenderUrl] = useState<string | null>(null);
  const lastRenderPath = useRef<string | null>(null);

  const renders: any[] = status?.renders ?? [];
  const render = renders.find((r) => r.kind === renderKind);
  useEffect(() => {
    if (!render?.url) {
      setStableRenderUrl(null);
      lastRenderPath.current = null;
      return;
    }
    const path = render.url.split("?")[0];
    if (path !== lastRenderPath.current) {
      lastRenderPath.current = path;
      setStableRenderUrl(render.url);
    }
  }, [render?.url]);

  if (!status) return null;
  const stages: any[] = status.stages ?? [];
  const shots = status.shots ?? { total: 0, done: 0 };
  const projectStatus: string = status.project?.status ?? "draft";

  // In-progress = pipeline is actively working (not a terminal state).
  const inProgress = !["draft", "ready", "failed", "expired"].includes(projectStatus);
  async function cancel() {
    if (!confirm("Stop this generation? Completed work is kept; you can Generate again after.")) return;
    setCancelling(true);
    await fetch(`/api/projects/${projectId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ renderKind }),
    });
    setCancelling(false);
    onChange();
  }

  const started = stages.length > 0 || projectStatus !== "draft";
  const anyFailed = stages.some((s: any) => s.status === "failed") || projectStatus === "failed";

  // A SINGLE overall-progress percentage. We deliberately don't expose the
  // individual pipeline stages to end users — just one "generating" bar.
  const STATUS_PCT: Record<string, number> = {
    draft: 0, ingesting: 8, analyzing: 20, styling: 35, storyboarding: 50,
    generating: 55, assembling: 90, encoding: 95, ready: 100,
  };
  let pct = STATUS_PCT[projectStatus] ?? (started ? 5 : 0);
  if (projectStatus === "generating" && shots.total > 0) {
    pct = 55 + Math.round((shots.done / Math.max(1, shots.total)) * 33); // 55 → 88 across shots
  }

  return (
    <div className="panel">
      <div className="row spread">
        <h2 style={{ marginTop: 0 }}>Your video</h2>
        {inProgress && (
          <button type="button" className="link-danger" onClick={cancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>

      {inProgress && (
        <p className="small callout" style={{ margin: "4px 0 12px" }}>
          ⏳ This usually takes a few minutes — please <strong>keep this page open</strong> while your video generates so
          you can download it the moment it’s ready.
        </p>
      )}

      {!started ? (
        <p className="muted small">Not started yet. Click “Generate preview” above.</p>
      ) : !anyFailed ? (
        <div style={{ margin: "4px 0" }}>
          <div className="row spread small">
            <span>{projectStatus === "ready" ? "Ready ✓" : "Generating your video…"}</span>
            <span className="mono">{pct}%</span>
          </div>
          <div className="progress" style={{ marginTop: 6 }}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}

      {anyFailed && (
        <div className="callout" style={{ marginTop: 12 }}>
          <strong className="err">Your video didn’t finish generating.</strong>
          <p className="small muted" style={{ margin: "6px 0 0" }}>
            Please click <strong>Generate</strong> to try again. If it keeps happening, contact support.
          </p>
        </div>
      )}

      {render && stableRenderUrl && (
        <div style={{ marginTop: 14 }}>
          <video src={stableRenderUrl} controls style={{ width: "100%", borderRadius: 10, background: "#000" }} />
          <p className="row" style={{ marginTop: 10, gap: 8 }}>
            <button onClick={() => triggerDownload(render.downloadUrl ?? stableRenderUrl)}>
              ⬇ Download {renderKind} {render.watermarked ? "(watermarked)" : "(clean)"}
            </button>
            <button
              className="secondary"
              onClick={() => shareVideo(render.url ?? stableRenderUrl, `opmylife-${renderKind}.mp4`)}
            >
              ↗ Share
            </button>
          </p>
          <p className="small callout">
            ⚠ <strong>Download to keep it.</strong> This video and its history are automatically deleted{" "}
            {fmtExpiry(status.project?.expiresAt) ?? "after 3 days"} — we don't store your content long-term.
          </p>
        </div>
      )}
    </div>
  );
}

/** Friendly auto-delete deadline from an ISO expiry timestamp. */
function fmtExpiry(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return "very soon";
  const hrs = ms / 3.6e6;
  const when = new Date(t).toLocaleString();
  return hrs < 48 ? `in ~${Math.round(hrs)}h (${when})` : `in ~${Math.round(hrs / 24)} days (${when})`;
}

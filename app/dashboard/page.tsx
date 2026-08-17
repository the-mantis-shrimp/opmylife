"use client";

import { useEffect, useState } from "react";

interface Project {
  id: string;
  title: string;
  status: string;
  identity_path: string | null;
  created_at: string;
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [minTokens, setMinTokens] = useState(5);
  const [maxTokens, setMaxTokens] = useState(500);
  const [qty, setQty] = useState(25);
  const [buying, setBuying] = useState(false);
  const [showBuy, setShowBuy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [aspect, setAspect] = useState<"portrait" | "landscape">("portrait");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/projects");
    if (!res.ok) {
      setError("Failed to load projects. Is the database migrated and running?");
      return;
    }
    const data = await res.json();
    setProjects(data.projects ?? []);
    setCredits(data.credits ?? null);
    setBillingEnabled(data.billingEnabled ?? false);
    if (typeof data.minTokenPurchase === "number") setMinTokens(data.minTokenPurchase);
    if (typeof data.maxTokenPurchase === "number") setMaxTokens(data.maxTokenPurchase);
  }

  useEffect(() => {
    load();
    // Returning from Stripe Checkout — the webhook grants credits asynchronously,
    // so poll the balance briefly so it appears without a manual refresh.
    const params = new URLSearchParams(window.location.search);
    const purchase = params.get("purchase");
    if (purchase) {
      setNotice(
        purchase === "success"
          ? "Payment received — tokens will appear here in a few seconds."
          : "Checkout canceled — no charge was made.",
      );
      window.history.replaceState({}, "", "/dashboard");
      if (purchase === "success") {
        let n = 0;
        const t = setInterval(() => {
          load();
          if (++n >= 5) clearInterval(t);
        }, 2000);
      }
    }
  }, []);

  async function buy() {
    const n = Math.min(maxTokens, Math.max(minTokens, Math.floor(qty || 0)));
    setBuying(true);
    setError(null);
    const res = await fetch("/api/stripe/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: n }),
    });
    if (!res.ok) {
      setBuying(false);
      setError((await res.json()).error ?? "Could not start checkout");
      return;
    }
    const { url } = await res.json();
    window.location.href = url; // to Stripe Checkout
  }

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, aspectRatio: aspect }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed to create project");
      return;
    }
    const { project } = await res.json();
    setTitle("");
    window.location.href = `/projects/${project.id}`;
  }

  async function remove(p: Project) {
    if (!confirm(`Delete "${p.title}"? This stops any generation and permanently deletes its photos, music, and videos.`)) {
      return;
    }
    setProjects((ps) => ps.filter((x) => x.id !== p.id)); // optimistic
    const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed to delete project");
      load(); // restore accurate list on failure
    }
  }

  return (
    <div className="themed">
      <div className="dash-head">
        <h1 className="dash-title">Your Projects</h1>
        <p className="muted">Upload photos + a song → a beat-synced OP.</p>
        <div className="token-bar">
          <span className="token-count">🪙 {credits === null ? "…" : credits} tokens</span>
          {billingEnabled && (
            <button className="btn-cta" onClick={() => setShowBuy((v) => !v)}>
              Buy tokens
            </button>
          )}
        </div>
      </div>

      {notice && (
        <p className="small callout" style={{ marginTop: 8 }}>
          {notice}
        </p>
      )}

      {billingEnabled && showBuy && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Buy tokens</h2>
          <p className="muted small">
            <strong>1 token = $1.</strong> Tokens are spent when you generate a final (clean, full-res) render;
            previews are free. <strong>All sales are final — tokens are non-refundable.</strong>
          </p>
          <div className="row" style={{ alignItems: "center", gap: 10 }}>
            <input
              type="number"
              min={minTokens}
              max={maxTokens}
              step={1}
              value={qty}
              onChange={(e) => setQty(Math.min(maxTokens, Math.max(minTokens, Math.floor(Number(e.target.value) || 0))))}
              style={{ width: 110 }}
              aria-label="Number of tokens"
            />
            <span className="muted">tokens</span>
            <button className="btn-cta" onClick={buy} disabled={buying}>
              {buying ? "Redirecting…" : `Buy for $${Math.min(maxTokens, Math.max(minTokens, Math.floor(qty || 0)))}`}
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>{minTokens}–{maxTokens} tokens per purchase.</p>
        </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>New project</h2>
        <div className="row">
          <input
            type="text"
            placeholder="Title (shown on the title card)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <select className="select" value={aspect} onChange={(e) => setAspect(e.target.value as "portrait" | "landscape")}>
            <option value="portrait">Vertical · 9:16 (phone)</option>
            <option value="landscape">Horizontal · 16:9 (widescreen)</option>
          </select>
          <button onClick={create} disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Aspect ratio is set at creation and can’t be changed later.</p>
      </div>

      {error && <p className="err">{error}</p>}

      <h2>Projects</h2>
      {projects.length === 0 ? (
        <p className="muted">No projects yet. Create one above.</p>
      ) : (
        <ul className="clean">
          {projects.map((p) => (
            <li key={p.id} className="row spread">
              <div>
                <a href={`/projects/${p.id}`}>{p.title}</a>
                <span className="muted small">
                  {" "}
                  · {p.identity_path ?? "no consent yet"}
                </span>
              </div>
              <div className="row" style={{ gap: 10 }}>
                <span className="badge">{p.status}</span>
                <button className="link-danger" onClick={() => remove(p)} title="Delete project" aria-label="Delete project">
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

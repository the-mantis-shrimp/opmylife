"use client";

import { useEffect, useState } from "react";

/**
 * Light/dark toggle. With no explicit choice the app follows the browser's
 * prefers-color-scheme (handled in CSS); clicking sets an explicit override on
 * <html data-theme> and persists it. A tiny inline script in the layout applies
 * the stored choice before paint to avoid a flash.
 */
export function ThemeToggle() {
  const [effective, setEffective] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") {
      setEffective(stored);
    } else {
      setEffective(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    }
  }, []);

  function toggle() {
    const next = effective === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
    setEffective(next);
  }

  return (
    <button
      type="button"
      className="secondary theme-toggle"
      onClick={toggle}
      title="Toggle light / dark"
      aria-label="Toggle light or dark theme"
    >
      {effective === "dark" ? "☀" : "☾"}
    </button>
  );
}

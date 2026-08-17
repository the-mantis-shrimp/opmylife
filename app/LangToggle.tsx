"use client";

/**
 * Language toggle. Writes the choice to a `lang` cookie and reloads so the
 * server-rendered pages re-render in the new language. The current language is
 * passed in from the server (which read the cookie) to avoid a flash.
 */
export function LangToggle({ current }: { current: "en" | "es" }) {
  function setLang(lang: "en" | "es") {
    if (lang === current) return;
    document.cookie = `lang=${lang}; path=/; max-age=31536000; samesite=lax`;
    location.reload();
  }
  const next = current === "en" ? "es" : "en";
  return (
    <button
      type="button"
      className="secondary theme-toggle"
      onClick={() => setLang(next)}
      title={current === "en" ? "Cambiar a Español" : "Switch to English"}
      aria-label="Change language"
    >
      {current === "en" ? "ES" : "EN"}
    </button>
  );
}

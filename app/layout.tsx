import type { Metadata } from "next";
import { ClerkProvider, SignedIn, SignedOut, SignInButton, SignOutButton, UserButton } from "@clerk/nextjs";
import { env } from "../lib/env";
import { LEGAL } from "../lib/legal";
import { getLang, t, type Lang } from "../lib/i18n";
import { ThemeToggle } from "./ThemeToggle";
import { LangToggle } from "./LangToggle";
import "./globals.css";

// Apply the saved light/dark choice before paint to avoid a flash.
const THEME_SCRIPT =
  "try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}";

export const metadata: Metadata = {
  title: "OPmylife",
  description: "Turn your photos + a song into a beat-synced animated opening.",
};

// The topbar's Clerk <SignedIn>/<SignedOut> controls (incl. the Log out button)
// need per-request auth to render the right state. Statically-prerendered routes
// (e.g. /dashboard, /about, /legal/*) would otherwise bake in the signed-OUT
// branch at build time and never show Log out. Forcing dynamic rendering app-wide
// makes the account controls appear consistently on every page, not just the
// dynamic ones like /projects/[id].
export const dynamic = "force-dynamic";

function Shell({ children, authControls, lang }: { children: React.ReactNode; authControls?: React.ReactNode; lang: Lang }) {
  return (
    <body>
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <header className="topbar">
        <a href="/" className="brand" aria-label="OPmylife home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="OPmylife" style={{ height: 44, width: "auto", display: "block" }} />
        </a>
        <div className="row" style={{ gap: 14 }}>
          <nav className="nav">
            <a href="/dashboard" className="nav-cta">{t(lang, "nav.dashboard")}</a>
            <a href="/gallery">{t(lang, "nav.gallery")}</a>
            <a href="/about">{t(lang, "nav.about")}</a>
          </nav>
          <LangToggle current={lang} />
          <ThemeToggle />
          {authControls}
        </div>
      </header>
      <main className="container">{children}</main>
      <footer className="container" style={{ paddingTop: 0 }}>
        <p className="small muted" style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <a href="/legal/terms">{t(lang, "footer.terms")}</a> · <a href="/legal/privacy">{t(lang, "footer.privacy")}</a> ·{" "}
          <a href={`mailto:${LEGAL.supportEmail}`}>{t(lang, "footer.support")}</a>
        </p>
      </footer>
    </body>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = getLang();
  // Clerk wraps the tree only when configured; otherwise the dev-user path runs
  // and no auth UI is shown (see docs/setup.md Stage 2). NB: ClerkProvider and the
  // auth components must be imported the SAME way (ESM) so the React context they
  // share is a single instance — mixing `require` here breaks `useSession`.
  if (env.clerk.configured) {
    return (
      <ClerkProvider>
        <html lang={lang}>
          <Shell
            lang={lang}
            authControls={
              <>
                <SignedIn>
                  <UserButton afterSignOutUrl="/" />
                  <SignOutButton>
                    <button className="secondary">{t(lang, "auth.logout")}</button>
                  </SignOutButton>
                </SignedIn>
                <SignedOut>
                  <SignInButton mode="modal">
                    <button className="secondary">{t(lang, "auth.signin")}</button>
                  </SignInButton>
                </SignedOut>
              </>
            }
          >
            {children}
          </Shell>
        </html>
      </ClerkProvider>
    );
  }

  return (
    <html lang={lang}>
      <Shell lang={lang}>{children}</Shell>
    </html>
  );
}

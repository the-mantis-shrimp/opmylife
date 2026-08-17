import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Clerk is the locked auth provider. To keep the Phase-1 slice runnable before
// keys are wired (no Clerk env), we only engage Clerk's middleware when a
// publishable key is present; otherwise requests pass through and `lib/auth`
// resolves a dev user. See docs/setup.md Stage 2.
const clerkConfigured = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

let handler: (req: NextRequest) => Response | Promise<Response> | NextResponse;

if (clerkConfigured) {
  // Lazy require so the package isn't initialized when unconfigured.
  const { clerkMiddleware, createRouteMatcher } = require("@clerk/nextjs/server");
  // Protect app PAGES (redirect signed-out users to /sign-in). The marketing
  // pages (/, /gallery, /about, /legal/*) stay public. API routes self-enforce
  // via lib/auth.currentUser() and return 401, so they're left out here.
  const isProtectedPage = createRouteMatcher(["/dashboard(.*)", "/projects(.*)"]);
  handler = clerkMiddleware((auth: any, req: NextRequest) => {
    if (isProtectedPage(req)) auth().protect();
  });
} else {
  handler = () => NextResponse.next();
}

export default handler;

export const config = {
  matcher: [
    // Run on everything except static assets and Next internals.
    "/((?!_next|.*\\..*).*)",
    "/(api|trpc)(.*)",
  ],
};

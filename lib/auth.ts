/**
 * Auth boundary for API routes. Clerk is the locked provider. When Clerk is not
 * configured (Phase-1 local dev, MODELS_MODE=stub) we resolve a stable DEV user
 * so the slice is runnable without auth keys. In production Clerk is configured
 * and this returns the real signed-in subject.
 */
import { env } from "./env";
import { getOrCreateUser, type UserRow } from "./users";

const DEV_CLERK_ID = "dev_user_local";
const DEV_EMAIL = "dev@local.test";

/** Resolve the current user row (creating it + starter grant on first call). */
export async function currentUser(): Promise<UserRow> {
  if (!env.clerk.configured) {
    return getOrCreateUser(DEV_CLERK_ID, DEV_EMAIL);
  }
  // Clerk is configured — read the signed-in subject from the request context.
  const { auth, currentUser: clerkCurrentUser } = await import("@clerk/nextjs/server");
  const { userId } = auth();
  if (!userId) throw new UnauthorizedError();
  const cu = await clerkCurrentUser();
  const email = cu?.primaryEmailAddress?.emailAddress ?? null;
  return getOrCreateUser(userId, email);
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

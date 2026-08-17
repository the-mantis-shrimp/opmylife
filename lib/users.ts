/** Users: mirror of Clerk identity. We key everything to our own users.id. */
import { queryOne } from "./db";
import { ensureStarterGrant } from "./billing";

export interface UserRow {
  id: string;
  clerk_id: string;
  email: string | null;
  created_at: string;
}

/**
 * Map a Clerk subject to our users row, creating it on first sign-in and seeding
 * the Phase-1 starter credit grant. Idempotent.
 */
export async function getOrCreateUser(clerkId: string, email?: string | null): Promise<UserRow> {
  const user = await queryOne<UserRow>(
    `INSERT INTO users (clerk_id, email)
     VALUES ($1, $2)
     ON CONFLICT (clerk_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email)
     RETURNING *`,
    [clerkId, email ?? null],
  );
  if (!user) throw new Error("failed to upsert user");
  await ensureStarterGrant(user.id);
  return user;
}

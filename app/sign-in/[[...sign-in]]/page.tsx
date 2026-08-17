import { SignIn } from "@clerk/nextjs";

// Only reachable when Clerk is configured (middleware redirects here). Dynamic so
// the build never tries to prerender it without a Clerk provider.
export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
      <SignIn />
    </div>
  );
}

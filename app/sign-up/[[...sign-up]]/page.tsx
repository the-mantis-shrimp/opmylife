import { SignUp } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
      <SignUp />
    </div>
  );
}

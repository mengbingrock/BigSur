import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { getCurrentEmail } from "@/lib/session";
import { isSignupEnabled } from "@/lib/users";

export const metadata = {
  title: "Create account — Monterey",
};

export default async function SignupPage() {
  const email = await getCurrentEmail();
  if (email) redirect("/chat");

  if (!isSignupEnabled()) {
    return (
      <div className="mx-auto w-full max-w-sm px-6 py-16">
        <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
          Monterey
        </p>
        <h1 className="mb-4 font-serif text-4xl leading-tight tracking-tight text-ink">
          Signup disabled
        </h1>
        <p className="text-sm text-muted">
          This instance has open signup turned off. Ask the host to create an
          account for you, then{" "}
          <Link
            href="/login"
            className="text-ink underline underline-offset-2"
          >
            sign in
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <Suspense fallback={null}>
      <AuthForm mode="signup" signupEnabled />
    </Suspense>
  );
}

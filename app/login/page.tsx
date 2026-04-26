import { Suspense } from "react";
import { redirect } from "next/navigation";
import AuthForm from "@/components/AuthForm";
import { getCurrentEmail } from "@/lib/session";
import { isSignupEnabled } from "@/lib/users";

export const metadata = {
  title: "Sign in — Monterey",
};

export default async function LoginPage() {
  const email = await getCurrentEmail();
  if (email) redirect("/chat");
  return (
    <Suspense fallback={null}>
      <AuthForm mode="login" signupEnabled={isSignupEnabled()} />
    </Suspense>
  );
}

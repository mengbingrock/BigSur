import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, LogIn, UserPlus } from "lucide-react";
import { ApiError } from "~/lib/api";
import { useAuthProviders, useLogin, useSignup } from "~/lib/auth";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { GoogleButton } from "~/components/GoogleButton";

interface Props {
  mode: "login" | "signup";
  next?: string;
  signupEnabled?: boolean;
  initialError?: string;
}

export function AuthForm({ mode, next = "/chat", signupEnabled = true, initialError }: Props) {
  const navigate = useNavigate();
  const login = useLogin();
  const signup = useSignup();
  const providers = useAuthProviders();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);

  const isLogin = mode === "login";
  const busy = login.isPending || signup.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const mutation = isLogin ? login : signup;
      await mutation.mutateAsync({ email, password });
      navigate({ to: next });
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Something went wrong.",
      );
    }
  };

  const title = isLogin ? "Sign in" : "Create your account";
  const submitLabel = isLogin ? "Sign in" : "Create account";
  const Icon = isLogin ? LogIn : UserPlus;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.22em] text-ink-faint">
          Labee
        </p>
        <h1 className="font-display text-3xl tracking-tight text-ink">{title}</h1>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 shadow-xs">
        {providers.data?.google && (
          <div className="mb-5 flex flex-col gap-4">
            <GoogleButton next={next} label={isLogin ? "Sign in with Google" : "Sign up with Google"} />
            <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-ink-faint">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Email</span>
            <Input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-baseline gap-2 text-sm font-medium text-ink">
              Password
              {!isLogin && (
                <span className="text-xs font-normal text-ink-light">
                  (min 8 chars)
                </span>
              )}
            </span>
            <Input
              type="password"
              required
              minLength={isLogin ? undefined : 8}
              autoComplete={isLogin ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button type="submit" disabled={busy} className="mt-2 w-full">
            {busy ? <Loader2 className="animate-spin" /> : <Icon />}
            {submitLabel}
          </Button>
        </form>
      </div>

      <div className="text-sm text-ink-light">
        {isLogin ? (
          signupEnabled ? (
            <>
              Don&apos;t have an account?{" "}
              <Link
                to="/signup"
                className="font-medium text-brand underline-offset-4 hover:underline"
              >
                Create one
              </Link>
              .
            </>
          ) : (
            <>Signup is disabled. Ask the host to create an account for you.</>
          )
        ) : (
          <>
            Already have an account?{" "}
            <Link
              to="/login"
              className="font-medium text-brand underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
            .
          </>
        )}
      </div>
    </div>
  );
}

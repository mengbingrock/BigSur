"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, LogIn, UserPlus } from "lucide-react";

interface Props {
  mode: "login" | "signup";
  signupEnabled?: boolean;
}

export default function AuthForm({ mode, signupEnabled = true }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/chat";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/signup";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const isLogin = mode === "login";
  const title = isLogin ? "Sign in" : "Create your account";
  const submitLabel = isLogin ? "Sign in" : "Create account";
  const Icon = isLogin ? LogIn : UserPlus;

  return (
    <div className="mx-auto w-full max-w-sm px-6 py-16">
      <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
        Monterey
      </p>
      <h1 className="mb-6 font-serif text-4xl leading-tight tracking-tight text-ink">
        {title}
      </h1>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-[0.16em] text-muted">
            Email
          </span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-[0.16em] text-muted">
            Password
            {!isLogin && (
              <span className="ml-2 normal-case tracking-normal text-[11px] text-muted">
                (min 8 chars)
              </span>
            )}
          </span>
          <input
            type="password"
            required
            minLength={isLogin ? undefined : 8}
            autoComplete={isLogin ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
          />
        </label>

        {error && (
          <div className="border border-rule bg-ink/5 px-3 py-2 text-xs text-ink">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 inline-flex items-center justify-center gap-2 border border-ink bg-ink px-4 py-2.5 text-sm font-medium text-paper transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Icon size={14} />
          )}
          {submitLabel}
        </button>
      </form>

      <div className="mt-6 text-xs text-muted">
        {isLogin ? (
          signupEnabled ? (
            <>
              Don&apos;t have an account?{" "}
              <Link href="/signup" className="text-ink underline underline-offset-2">
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
            <Link href="/login" className="text-ink underline underline-offset-2">
              Sign in
            </Link>
            .
          </>
        )}
      </div>
    </div>
  );
}

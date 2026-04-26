"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, LogOut } from "lucide-react";

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    router.push("/");
    router.refresh();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1 text-xs text-muted transition hover:text-ink disabled:opacity-60"
    >
      {busy ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <LogOut size={12} />
      )}
      Sign out
    </button>
  );
}

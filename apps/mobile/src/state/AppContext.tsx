// App-wide state: which server we talk to (Target), who is signed in, and the
// selected Mac when going through the relay. Persisted across launches.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import {
  deleteAccount as apiDeleteAccount,
  me as fetchMe,
  login as apiLogin,
  logout as apiLogout,
  type User,
} from "~/api/auth";
import { setDeviceToken, setSessionToken, type Target } from "~/api/client";
import { getPref, getSecret, setPref, setSecret } from "~/storage";

const DEFAULT_BASE = Platform.OS === "web" && typeof location !== "undefined" && location.origin.startsWith("http")
  ? location.origin
  : "https://labee.online";

export interface AppState {
  ready: boolean;
  target: Target;
  user: User | null;
  error: string | null;
  setBase: (base: string) => Promise<void>;
  setHostId: (hostId: string | undefined) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  /** Native: open the hosted Google flow and capture the sealed session it hands back. */
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Erase the account server-side and forget it locally. Throws on failure. */
  deleteAccount: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [base, setBaseState] = useState(DEFAULT_BASE);
  const [hostId, setHostIdState] = useState<string | undefined>(undefined);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = useMemo<Target>(() => ({ base, ...(hostId ? { hostId } : {}) }), [base, hostId]);
  const rootTarget = useMemo<Target>(() => ({ base }), [base]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetchMe(rootTarget);
      setUser(r.user);
      setError(null);
    } catch (e) {
      setUser(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rootTarget]);

  useEffect(() => {
    (async () => {
      const savedBase = await getPref("labee:base");
      const savedHost = await getPref("labee:hostId");
      const token = await getSecret("labee:deviceToken");
      if (token) setDeviceToken(token);
      const session = await getSecret("labee:session");
      if (session) setSessionToken(session);
      if (savedBase) setBaseState(savedBase);
      if (savedHost) setHostIdState(savedHost);
      // Check who we are BEFORE any screen decides to redirect to sign-in.
      const base = (savedBase ?? DEFAULT_BASE).replace(/\/+$/, "");
      try {
        const r = await fetchMe({ base });
        setUser(r.user);
      } catch {
        setUser(null);
      }
      setReady(true);
    })();
  }, []);

  // Sealed session handed to the app through its custom scheme
  // (labee://auth?session=…&base=…): the Google sign-in return path, and a
  // way to sign a device in from a link or a test harness.
  useEffect(() => {
    if (!ready) return;
    const handle = async (url: string | null) => {
      if (!url || !url.startsWith("labee://auth")) return;
      const u = new URL(url);
      const sealed = u.searchParams.get("session");
      const b = u.searchParams.get("base");
      if (b) {
        const clean = b.replace(/\/+$/, "");
        setBaseState(clean);
        await setPref("labee:base", clean);
      }
      if (sealed) {
        setSessionToken(sealed);
        await setSecret("labee:session", sealed);
      }
      await refresh();
    };
    let sub: { remove: () => void } | null = null;
    (async () => {
      const Linking = await import("expo-linking");
      await handle(await Linking.getInitialURL());
      sub = Linking.addEventListener("url", (e) => void handle(e.url));
    })();
    return () => sub?.remove();
  }, [ready, refresh]);

  const setBase = useCallback(async (b: string) => {
    const clean = b.trim().replace(/\/+$/, "");
    setBaseState(clean);
    await setPref("labee:base", clean);
  }, []);

  const setHostId = useCallback(async (h: string | undefined) => {
    setHostIdState(h);
    await setPref("labee:hostId", h ?? null);
  }, []);

  // First sign-in on a device: if the account already has a linked Mac and the
  // person has never chosen one here, pick it for them so the Sessions tab is
  // not empty. An explicit "Direct" choice is stored as "" and is respected;
  // only a missing preference triggers this.
  useEffect(() => {
    if (!ready || !user) return;
    let cancelled = false;
    (async () => {
      if ((await getPref("labee:hostId")) != null) return;
      try {
        const { listHosts } = await import("~/api/link");
        const { hosts } = await listHosts(rootTarget);
        if (cancelled || hosts.length === 0) return;
        const pick =
          hosts.find((h) => h.online) ??
          [...hosts].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))[0];
        if (pick && !cancelled) await setHostId(pick.hostId);
      } catch {
        // no relay reachable; stay direct
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, user, rootTarget, setHostId]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await apiLogin(rootTarget, email, password);
      await refresh();
    },
    [rootTarget, refresh],
  );

  const signInWithGoogle = useCallback(async () => {
    if (Platform.OS === "web") {
      // Same-origin cookie flow.
      location.href = `${base}/api/auth/google?next=${encodeURIComponent("/")}`;
      return;
    }
    const WebBrowser = await import("expo-web-browser");
    const Linking = await import("expo-linking");
    const returnUrl = Linking.createURL("auth");
    const result = await WebBrowser.openAuthSessionAsync(
      `${base}/api/auth/google?mobile=${encodeURIComponent(returnUrl)}`,
      returnUrl,
    );
    if (result.type !== "success") throw new Error("Google sign-in was cancelled.");
    const sealed = new URL(result.url).searchParams.get("session");
    if (!sealed) throw new Error("Google sign-in did not return a session.");
    setSessionToken(sealed);
    await setSecret("labee:session", sealed);
    await refresh();
  }, [base, refresh]);

  const forgetLocalSession = useCallback(async () => {
    setDeviceToken(null);
    setSessionToken(null);
    await setSecret("labee:deviceToken", null);
    await setSecret("labee:session", null);
    setUser(null);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiLogout(rootTarget);
    } catch {
      // ignore
    }
    await forgetLocalSession();
  }, [rootTarget, forgetLocalSession]);

  // Always against the account server (rootTarget), never through a Mac relay:
  // the account lives on the box, and the relay only proxies session traffic.
  // Unlike signOut this must not swallow errors — the person needs to know if
  // the erase did not happen.
  const deleteAccount = useCallback(async () => {
    await apiDeleteAccount(rootTarget);
    await forgetLocalSession();
  }, [rootTarget, forgetLocalSession]);

  const value = useMemo<AppState>(
    () => ({ ready, target, user, error, setBase, setHostId, signIn, signInWithGoogle, signOut, deleteAccount, refresh }),
    [ready, target, user, error, setBase, setHostId, signIn, signInWithGoogle, signOut, deleteAccount, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

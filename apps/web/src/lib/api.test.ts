import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHostId, resolve, setHostId, subscribeHostId } from "./api";

const HOST = "host_e61ec2ebd081";

/** Minimal localStorage so the persistence path is exercised rather than
 *  silently falling into its catch. */
function installStorage() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  return map;
}

let store: Map<string, string>;

beforeEach(() => {
  store = installStorage();
  setHostId(null);
});

afterEach(() => {
  setHostId(null);
  delete (globalThis as { window?: unknown }).window;
});

describe("resolve", () => {
  it("leaves every path alone when no Mac is selected", () => {
    expect(getHostId()).toBeNull();
    for (const p of ["/api/skills", "/api/sessions", "/api/me", "/assets/x.png"]) {
      expect(resolve(p)).toBe(p);
    }
  });

  it("routes app traffic to the selected Mac", () => {
    setHostId(HOST);
    expect(resolve("/api/skills")).toBe(`/api/hosts/${HOST}/api/skills`);
    expect(resolve("/api/sessions/abc/turns")).toBe(`/api/hosts/${HOST}/api/sessions/abc/turns`);
    // Query strings ride along untouched.
    expect(resolve("/api/research/runs/1/events?after=0")).toBe(
      `/api/hosts/${HOST}/api/research/runs/1/events?after=0`,
    );
  });

  it("keeps the account and the relay's own control plane on the box", () => {
    setHostId(HOST);
    // If any of these were relayed, the browser would ask a Mac who you are,
    // what you owe, or which Macs exist — which is the box's job alone.
    for (const p of [
      "/api/me",
      "/api/logout",
      "/api/auth/google",
      "/api/link/hosts",
      "/api/link/devices",
      "/api/billing/portal",
      "/api/admin/users",
      "/api/llm/proxy-token",
    ]) {
      expect(resolve(p), p).toBe(p);
    }
  });

  it("relays the LLM settings, so a Mac's account can be set from the browser", () => {
    setHostId(HOST);
    // This is the point of the feature: switching the Mac to its own
    // subscription has to happen on the Mac.
    expect(resolve("/api/llm/settings")).toBe(`/api/hosts/${HOST}/api/llm/settings`);
    expect(resolve("/api/llm/connection")).toBe(`/api/hosts/${HOST}/api/llm/connection`);
  });

  it("never prefixes an already-addressed host path", () => {
    setHostId(HOST);
    const already = `/api/hosts/${HOST}/api/sessions`;
    expect(resolve(already)).toBe(already);
  });

  it("ignores anything that is not an /api path", () => {
    setHostId(HOST);
    expect(resolve("/assets/app.js")).toBe("/assets/app.js");
    expect(resolve("/login")).toBe("/login");
  });

  it("never relays from the desktop app, which is itself the Mac", () => {
    setHostId(HOST);
    (globalThis as { window?: unknown }).window = { labeeDesktop: { isDesktop: true } };
    expect(resolve("/api/skills")).toBe("/api/skills");
  });

  it("escapes a host id rather than letting it shape the path", () => {
    setHostId("../evil");
    expect(resolve("/api/skills")).toBe("/api/hosts/..%2Fevil/api/skills");
  });
});

describe("host selection", () => {
  it("persists the choice and clears it again", () => {
    setHostId(HOST);
    expect(store.get("labee:hostId")).toBe(HOST);
    setHostId(null);
    expect(store.has("labee:hostId")).toBe(false);
    expect(getHostId()).toBeNull();
  });

  it("treats blank input as no Mac", () => {
    setHostId("   ");
    expect(getHostId()).toBeNull();
  });

  it("notifies subscribers so the UI and caches can react", () => {
    let calls = 0;
    const off = subscribeHostId(() => calls++);
    setHostId(HOST);
    expect(calls).toBe(1);
    off();
    setHostId(null);
    expect(calls).toBe(1);
  });
});

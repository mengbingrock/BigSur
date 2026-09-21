// Push pipeline end to end with a fake Expo push endpoint (EXPO_PUSH_URL):
// desktop → mirror → box decides → POST to Expo → the phone's token.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTestEnv, waitFor } from "./helpers/env";
import { freePort, startServer, type TestServer } from "./helpers/server";

const EMAIL = "dave@example.com";
let box: TestServer;
let desktop: TestServer;
let cookie: string;
let pushServer: http.Server;
const pushes: { to: string; title: string; body: string; data: Record<string, unknown> }[] = [];

beforeAll(async () => {
  applyTestEnv("push-box");
  const { sealSession } = await import("../src/services/session");
  const sealed = await sealSession({ email: EMAIL });
  cookie = `monterey_session=${encodeURIComponent(sealed)}`;
  const pushPort = await freePort();
  pushServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        pushes.push(...(JSON.parse(body) as typeof pushes));
      } catch {
        // ignore
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ status: "ok" }] }));
    });
  });
  await new Promise<void>((r) => pushServer.listen(pushPort, "127.0.0.1", r));
  const shared = { SESSION_PASSWORD: process.env.SESSION_PASSWORD!, CLAUDE_BIN: process.env.CLAUDE_BIN!, COOKIE_SECURE: "false" };
  box = await startServer({
    ...shared,
    EXPO_PUSH_URL: `http://127.0.0.1:${pushPort}/push`,
    LABEE_LINK_PING_MS: "700",
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
  });
  const droot = fs.mkdtempSync(path.join(os.tmpdir(), "labee-push-desktop-"));
  const sessionFile = path.join(droot, "remote-session.txt");
  fs.writeFileSync(sessionFile, encodeURIComponent(sealed));
  desktop = await startServer({
    ...shared,
    LABEE_MODE: "desktop",
    LABEE_DATA_DIR: path.join(droot, "data"),
    DECK_ROOT: path.join(droot, "decks"),
    SKILLS_ROOTS: path.join(droot, "skills"),
    LABEE_SKILLS_SERVER: box.base,
    LABEE_REMOTE_SESSION_FILE: sessionFile,
  });
}, 60000);

afterAll(() => {
  box?.stop();
  desktop?.stop();
  pushServer?.close();
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${box.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

describe("push notifications", () => {
  it("pushes to a paired device when the agent asks a question, and when a turn finishes unwatched", async () => {
    // Pair + approve a phone, register its push token.
    const { device, token } = (await (await api("/api/link/devices", { method: "POST", body: JSON.stringify({ name: "iPhone", platform: "iPhone" }) })).json()) as { device: { id: string }; token: string };
    await api(`/api/link/pending/${device.id}/approve`, { method: "POST" });
    const reg = await fetch(`${box.base}/api/link/push-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ pushToken: "ExponentPushToken[phone-1]" }),
    });
    expect(reg.status).toBe(200);

    let hostId = "";
    await waitFor(async () => {
      const r = (await (await api("/api/link/hosts")).json()) as { hosts: { hostId: string; online: boolean }[] };
      hostId = r.hosts.find((h) => h.online)?.hostId ?? "";
      return Boolean(hostId);
    }, 20000);

    // A question from the agent → push.
    const { session } = (await (await api(`/api/hosts/${hostId}/api/sessions`, { method: "POST", body: JSON.stringify({ title: "push me" }) })).json()) as { session: { id: string } };
    await api(`/api/hosts/${hostId}/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ text: "decide [[question]]" }) });
    await waitFor(() => pushes.some((p) => p.data.kind === "question"), 15000);
    const q = pushes.find((p) => p.data.kind === "question")!;
    expect(q.to).toBe("ExponentPushToken[phone-1]");
    expect(q.title).toBe("push me");
    expect(q.data).toMatchObject({ sessionId: session.id, hostId });

    // A finished turn with nobody watching → push with the reply text.
    const { session: s2 } = (await (await api(`/api/hosts/${hostId}/api/sessions`, { method: "POST", body: JSON.stringify({ title: "done push" }) })).json()) as { session: { id: string } };
    await api(`/api/hosts/${hostId}/api/sessions/${s2.id}/turns`, { method: "POST", body: JSON.stringify({ text: "finish quietly" }) });
    await waitFor(() => pushes.some((p) => p.data.kind === "done" && p.data.sessionId === s2.id), 15000);
    const d = pushes.find((p) => p.data.kind === "done" && p.data.sessionId === s2.id)!;
    expect(d.body).toContain("Hello from fake claude");
  }, 60000);
});

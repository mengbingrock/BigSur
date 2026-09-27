// Two real servers: a "box" (relay) and a "desktop" that dials it. A phone is
// simulated with fetch against the box.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTestEnv, sleep, waitFor } from "./helpers/env";
import { readSse, startServer, type TestServer } from "./helpers/server";

const EMAIL = "carol@example.com";
let box: TestServer;
let desktop: TestServer;
let cookie: string;

beforeAll(async () => {
  applyTestEnv("link-box");
  const { sealSession } = await import("../src/services/session");
  const sealed = await sealSession({ email: EMAIL });
  cookie = `monterey_session=${encodeURIComponent(sealed)}`;
  const shared = {
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
  };
  box = await startServer({ ...shared, LABEE_LINK_PING_MS: "700", LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!, DECK_ROOT: process.env.DECK_ROOT!, SKILLS_ROOTS: process.env.SKILLS_ROOTS! });
  const droot = fs.mkdtempSync(path.join(os.tmpdir(), "labee-link-desktop-"));
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
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${box.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

type Frame = { event: string; data: Record<string, unknown>; id?: string };
const evType = (f: Frame) => String(f.data.type);

describe("Device Link", () => {
  let hostId: string;

  it("desktop registers with the box and shows up as an online host", async () => {
    await waitFor(async () => {
      const r = (await (await api("/api/link/hosts")).json()) as { hosts: { hostId: string; online: boolean }[] };
      return r.hosts.some((h) => h.online);
    }, 20000);
    const r = (await (await api("/api/link/hosts")).json()) as { hosts: { hostId: string; name: string; online: boolean }[] };
    hostId = r.hosts.find((h) => h.online)!.hostId;
    expect(hostId).toMatch(/^host_/);
    expect(r.hosts[0]!.name.length).toBeGreaterThan(0);
  }, 30000);

  it("tunnels a session create + turn + SSE through the box, and mirrors it", async () => {
    const created = await api(`/api/hosts/${hostId}/api/sessions`, { method: "POST", body: JSON.stringify({ title: "via phone" }) });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    const tail = await api(`/api/hosts/${hostId}/api/sessions/${session.id}/events?after=0`, { headers: { accept: "text/event-stream" } });
    expect(tail.status).toBe(200);
    expect(tail.headers.get("content-type")).toContain("text/event-stream");

    const started = await api(`/api/hosts/${hostId}/api/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "x-labee-device": "iPhone" },
      body: JSON.stringify({ text: "hello through the relay" }),
    });
    expect(started.status).toBe(202);

    const frames = await readSse(tail, (f) => evType(f) === "turn_ended", 15000);
    const types = frames.map(evType);
    expect(types).toContain("turn_started");
    expect(types).toContain("delta");
    expect(types[types.length - 1]).toBe("turn_ended");

    // The desktop wrote it locally…
    const local = await fetch(`${desktop.base}/api/sessions/${session.id}`, { headers: { cookie } });
    expect(local.status).toBe(200);
    const localBody = (await local.json()) as { session: { title: string }; messages: unknown[] };
    expect(localBody.session.title).toBe("via phone");
    expect(localBody.messages).toHaveLength(2);

    // …and mirrored it to the box.
    await waitFor(async () => {
      const { getDb } = await import("../src/services/db");
      const db = await getDb();
      const row = db.prepare("SELECT COUNT(*) AS n FROM mirror_events WHERE session_id = ?").get(session.id);
      const msgs = db.prepare("SELECT COUNT(*) AS n FROM mirror_messages WHERE session_id = ?").get(session.id);
      return Number(row?.n ?? 0) > 3 && Number(msgs?.n ?? 0) === 2;
    }, 10000);
  }, 40000);

  it("lists every chat across machines, from the box and from a desktop alike", async () => {
    // The tunnel test above ran a turn on the desktop, which mirrored the
    // session to the box. Both surfaces should now list it, tagged with the
    // machine it lives on — that is what puts it in every device's Chats.
    type Row = { id: string; title: string; hostId: string; hostOnline: boolean };

    const onBox = (await (await api("/api/link/sessions")).json()) as { sessions: Row[] };
    const mine = onBox.sessions.find((s) => s.title === "via phone");
    expect(mine).toBeTruthy();
    expect(mine!.hostId).toBe(hostId);
    expect(mine!.hostOnline).toBe(true);

    // A desktop has no mirrors of its own; it asks the box and gets the same
    // answer, its own chats included.
    const r = await fetch(`${desktop.base}/api/link/sessions`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const onDesktop = (await r.json()) as { sessions: Row[] };
    expect(onDesktop.sessions.map((s) => s.id)).toEqual(onBox.sessions.map((s) => s.id));
  });

  it("a desktop lists the machines the box knows about, not its own registry", async () => {
    // Nothing ever dials a desktop, so its own host registry is empty — asking
    // it locally answered "nothing linked yet" on the machine that was itself
    // linked, directly below a panel saying "connected".
    const r = await fetch(`${desktop.base}/api/link/hosts`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const { hosts } = (await r.json()) as { hosts: { hostId: string; online: boolean }[] };
    expect(hosts.some((h) => h.hostId === hostId)).toBe(true);
  });

  it("a desktop lists and revokes the devices the box holds, not its own", async () => {
    // A phone pairs with the box, so the desktop's own link_devices table is
    // always empty. Reading it locally showed "no devices" on a machine that
    // plainly had some, and revoking there reported success while revoking
    // nothing.
    const created = await api("/api/link/devices", {
      method: "POST",
      body: JSON.stringify({ name: "iPad", platform: "iPad" }),
    });
    const { device } = (await created.json()) as { device: { id: string } };
    await api(`/api/link/pending/${device.id}/approve`, { method: "POST" });

    const seenByDesktop = async () => {
      const r = await fetch(`${desktop.base}/api/link/devices`, { headers: { cookie } });
      expect(r.status).toBe(200);
      return ((await r.json()) as { devices: { id: string }[] }).devices;
    };

    expect((await seenByDesktop()).some((d) => d.id === device.id)).toBe(true);

    // And revoking from the desktop reaches the box, rather than silently
    // doing nothing to an empty local table.
    const revoked = await fetch(`${desktop.base}/api/link/devices/${device.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoked.status).toBe(200);

    const onBox = (await (await api("/api/link/devices")).json()) as {
      devices: { id: string; status: string }[];
    };
    expect(onBox.devices.find((d) => d.id === device.id)?.status).toBe("revoked");
  });

  it("serves the mirror when the Mac is offline, and 503s for writes", async () => {
    // Create + run one turn while online so there's something to mirror.
    const { session } = (await (await api(`/api/hosts/${hostId}/api/sessions`, { method: "POST", body: "{}" })).json()) as { session: { id: string } };
    const t3 = await api(`/api/hosts/${hostId}/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ text: "remember me" }) });
    expect(t3.status).toBe(202);
    let lastSeen: unknown = null;
    try {
      await waitFor(async () => {
        const r = await api(`/api/hosts/${hostId}/api/sessions/${session.id}`);
        const g = (await r.json()) as { session?: { status: string; hostOnline?: boolean }; error?: string };
        lastSeen = { status: r.status, body: g };
        return g.session?.status === "idle";
      }, 15000);
    } catch (e) {
      console.log("DEBUG lastSeen", JSON.stringify(lastSeen));
      console.log("DEBUG desktop logs", desktop.logs.slice(-30).join(""));
      console.log("DEBUG box logs", box.logs.slice(-30).join(""));
      throw e;
    }
    await sleep(600); // let the mirror catch up

    desktop.stop();
    await waitFor(async () => {
      const r = (await (await api("/api/link/hosts")).json()) as { hosts: { hostId: string; online: boolean }[] };
      return r.hosts.some((h) => h.hostId === hostId && !h.online);
    }, 15000);

    const list = (await (await api(`/api/hosts/${hostId}/api/sessions`)).json()) as { sessions: { id: string; hostOnline: boolean }[] };
    expect(list.sessions.some((s) => s.id === session.id)).toBe(true);
    expect(list.sessions[0]!.hostOnline).toBe(false);

    const one = (await (await api(`/api/hosts/${hostId}/api/sessions/${session.id}`)).json()) as { session: { title: string }; messages: { role: string }[] };
    expect(one.session.title).toBe("remember me");
    expect(one.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const ev = await api(`/api/hosts/${hostId}/api/sessions/${session.id}/events?after=0`);
    const frames = await readSse(ev, () => false, 3000);
    expect(frames.map(evType)).toContain("turn_ended");
    expect(frames[frames.length - 1]!.data.type).toBe("session_status");

    const write = await api(`/api/hosts/${hostId}/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ text: "x" }) });
    expect(write.status).toBe(503);
  }, 60000);

  it("device pairing: pending until approved, then the bearer token authenticates", async () => {
    const created = await api("/api/link/devices", { method: "POST", body: JSON.stringify({ name: "iPhone 16", platform: "iPhone" }) });
    expect(created.status).toBe(201);
    const { device, token } = (await created.json()) as { device: { id: string; code: string; status: string }; token: string };
    expect(device.status).toBe("pending");
    expect(device.code).toMatch(/^\d{6}$/);
    expect(token).toMatch(/^lbd_/);

    // Not approved yet → bearer is rejected.
    const before = await fetch(`${box.base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
    expect(before.status).toBe(401);

    const pending = (await (await api("/api/link/pending")).json()) as { devices: { id: string }[] };
    expect(pending.devices.some((d) => d.id === device.id)).toBe(true);

    const approve = await api(`/api/link/pending/${device.id}/approve`, { method: "POST" });
    expect(approve.status).toBe(200);

    const after = await fetch(`${box.base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(200);

    const push = await fetch(`${box.base}/api/link/push-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ pushToken: "ExponentPushToken[test]" }),
    });
    expect(push.status).toBe(200);

    const revoke = await api(`/api/link/devices/${device.id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    const gone = await fetch(`${box.base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
    expect(gone.status).toBe(401);
  });
});

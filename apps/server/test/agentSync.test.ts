import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Each test gets its own database file; the agents service opens it lazily
 *  through ./db, so the env has to be set before the module is imported. */
let dir: string;
type Agents = typeof import("../src/services/agents");
let svc: Agents;

const EMAIL = "sync@example.com";

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "labee-agentsync-"));
  process.env.LABEE_DATA_DIR = dir;
  process.env.LABEE_DB_PATH = path.join(dir, "labee.sqlite");
  // ./db caches its connection at module scope, so the whole registry has to
  // be reset — importing agents with a cache-busting query would still reuse
  // the database opened by the first test.
  vi.resetModules();
  svc = (await import("../src/services/agents")) as Agents;
});

/** A wire agent, with the fields the merge actually reads. */
function wire(over: Partial<svcSyncAgent> & { id: string; updatedAt: string }): svcSyncAgent {
  return {
    name: "Agent",
    description: "",
    skillSlugs: [],
    workingDir: "",
    referenceFolders: [],
    engine: "claude",
    team: null,
    teamOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...over,
  } as svcSyncAgent;
}
type svcSyncAgent = import("../src/services/agents").SyncAgent;

describe("agent sync merge", () => {
  it("takes in an agent this device has never seen", async () => {
    const merged = await svc.mergeAgents(EMAIL, [
      wire({ id: "a1", name: "Literature Researcher", updatedAt: "2026-09-01T10:00:00.000Z" }),
    ]);
    expect(merged.map((a) => a.name)).toEqual(["Literature Researcher"]);
    expect((await svc.listAgents(EMAIL)).map((a) => a.name)).toEqual(["Literature Researcher"]);
  });

  it("lets the newer edit win, whichever side it came from", async () => {
    await svc.mergeAgents(EMAIL, [wire({ id: "a1", name: "old", updatedAt: "2026-09-01T10:00:00.000Z" })]);

    // Newer incoming replaces ours.
    await svc.mergeAgents(EMAIL, [wire({ id: "a1", name: "newer", updatedAt: "2026-09-01T11:00:00.000Z" })]);
    expect((await svc.listAgents(EMAIL))[0]!.name).toBe("newer");

    // Older incoming is ignored — this is the case that would otherwise undo
    // an edit whenever a stale device synced.
    await svc.mergeAgents(EMAIL, [wire({ id: "a1", name: "stale", updatedAt: "2026-08-01T00:00:00.000Z" })]);
    expect((await svc.listAgents(EMAIL))[0]!.name).toBe("newer");
  });

  it("is idempotent: re-sending the same rows changes nothing", async () => {
    const rows = [wire({ id: "a1", name: "p2", updatedAt: "2026-09-01T10:00:00.000Z" })];
    const first = await svc.mergeAgents(EMAIL, rows);
    const second = await svc.mergeAgents(EMAIL, rows);
    expect(second).toEqual(first);
  });

  it("propagates a deletion instead of resurrecting the agent", async () => {
    await svc.mergeAgents(EMAIL, [wire({ id: "a1", name: "p2", updatedAt: "2026-09-01T10:00:00.000Z" })]);
    expect(await svc.listAgents(EMAIL)).toHaveLength(1);

    // Another device deleted it.
    await svc.mergeAgents(EMAIL, [
      wire({
        id: "a1",
        name: "p2",
        updatedAt: "2026-09-01T12:00:00.000Z",
        deletedAt: "2026-09-01T12:00:00.000Z",
      }),
    ]);
    expect(await svc.listAgents(EMAIL)).toHaveLength(0);

    // The tombstone still travels, so a third device learns about it too.
    const forSync = await svc.listAgentsForSync(EMAIL);
    expect(forSync).toHaveLength(1);
    expect(forSync[0]!.deletedAt).toBeTruthy();
  });

  it("does not let a stale device undelete an agent", async () => {
    await svc.mergeAgents(EMAIL, [
      wire({
        id: "a1",
        name: "p2",
        updatedAt: "2026-09-01T12:00:00.000Z",
        deletedAt: "2026-09-01T12:00:00.000Z",
      }),
    ]);
    // A device that still holds the pre-deletion row syncs.
    await svc.mergeAgents(EMAIL, [wire({ id: "a1", name: "p2", updatedAt: "2026-09-01T10:00:00.000Z" })]);
    expect(await svc.listAgents(EMAIL)).toHaveLength(0);
  });

  it("deleting locally writes a tombstone rather than dropping the row", async () => {
    const created = await svc.createAgent(EMAIL, { name: "throwaway", workingDir: dir } as never);
    await svc.deleteAgent(EMAIL, created.id);

    expect(await svc.listAgents(EMAIL)).toHaveLength(0);
    const forSync = await svc.listAgentsForSync(EMAIL);
    expect(forSync.find((a) => a.id === created.id)?.deletedAt).toBeTruthy();
  });

  it("keeps each account's agents to itself", async () => {
    await svc.mergeAgents(EMAIL, [wire({ id: "a1", name: "mine", updatedAt: "2026-09-01T10:00:00.000Z" })]);
    await svc.mergeAgents("other@example.com", [
      wire({ id: "b1", name: "theirs", updatedAt: "2026-09-01T10:00:00.000Z" }),
    ]);
    expect((await svc.listAgents(EMAIL)).map((a) => a.name)).toEqual(["mine"]);
    expect((await svc.listAgents("other@example.com")).map((a) => a.name)).toEqual(["theirs"]);
  });

  it("announces local edits, but stays silent while reconciling", async () => {
    // The Device Link client syncs whenever this fires. If merging announced
    // itself, that sync would merge, which would announce, which would sync —
    // so this is the guard that stops an endless loop between device and box.
    const seen: string[] = [];
    const off = svc.subscribeAgents((email) => seen.push(email));
    try {
      const created = await svc.createAgent(EMAIL, { name: "local", workingDir: dir } as never);
      expect(seen).toEqual([EMAIL]);

      await svc.updateAgent(EMAIL, created.id, { name: "renamed", workingDir: dir } as never);
      expect(seen).toHaveLength(2);

      await svc.deleteAgent(EMAIL, created.id);
      expect(seen).toHaveLength(3);

      // Reconciliation is not a local edit.
      await svc.mergeAgents(EMAIL, [
        wire({ id: "remote-1", name: "from another Mac", updatedAt: "2026-09-02T10:00:00.000Z" }),
      ]);
      expect(seen).toHaveLength(3);
    } finally {
      off();
    }
  });

  it("returns teams contiguous and in hand-off order", async () => {
    // The agents page groups by walking this list in order, so the ordering is
    // a guarantee of the query, not something each page re-derives. Inserted
    // deliberately scrambled, and with the most recent edit in the middle.
    await svc.mergeAgents(EMAIL, [
      wire({ id: "c", name: "Solution Developer", team: "ScientistOne", teamOrder: 3, updatedAt: "2026-09-09T00:00:00.000Z" }),
      wire({ id: "loner-new", name: "p3", updatedAt: "2026-09-10T00:00:00.000Z" }),
      wire({ id: "a", name: "Literature Researcher", team: "ScientistOne", teamOrder: 1, updatedAt: "2026-09-01T00:00:00.000Z" }),
      wire({ id: "z", name: "unordered member", team: "ScientistOne", teamOrder: 0, updatedAt: "2026-09-02T00:00:00.000Z" }),
      wire({ id: "loner-old", name: "p2", updatedAt: "2026-09-03T00:00:00.000Z" }),
      wire({ id: "b", name: "Experiment Brief Writer", team: "ScientistOne", teamOrder: 2, updatedAt: "2026-09-08T00:00:00.000Z" }),
    ]);

    expect((await svc.listAgents(EMAIL)).map((a) => a.name)).toEqual([
      // the team, in the order it runs — 0 (unordered) settles at its end
      "Literature Researcher",
      "Experiment Brief Writer",
      "Solution Developer",
      "unordered member",
      // then everything else, most recently edited first
      "p3",
      "p2",
    ]);
  });

  it("ignores rows with no id rather than throwing", async () => {
    const merged = await svc.mergeAgents(EMAIL, [
      wire({ id: "", name: "nameless", updatedAt: "2026-09-01T10:00:00.000Z" }),
      wire({ id: "a1", name: "real", updatedAt: "2026-09-01T10:00:00.000Z" }),
    ]);
    expect(merged.map((a) => a.name)).toEqual(["real"]);
  });
});

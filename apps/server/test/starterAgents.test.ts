// The Protocol Agent is delivered to every account once, and a predecessor
// left on the retired shared skill is repaired in place rather than
// duplicated. Each test gets its own database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Agents = typeof import("../src/services/agents");
let svc: Agents;
let dir: string;
const EMAIL = "starter@example.com";

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "labee-starter-"));
  process.env.LABEE_DATA_DIR = dir;
  process.env.LABEE_DB_PATH = path.join(dir, "labee.sqlite");
  vi.resetModules();
  svc = (await import("../src/services/agents")) as Agents;
});

/** An agent row as the old marketplace install left it. */
async function plantLegacy(skill = "public--protocol-plan"): Promise<string> {
  const { getDb } = await import("../src/services/db");
  const db = await getDb();
  const id = "legacy-" + Math.random().toString(36).slice(2, 8);
  db.prepare(
    "INSERT INTO agents (id, email, name, description, skill_slugs, working_dir, reference_folders, engine, created_at, updated_at) " +
      "VALUES (?, ?, 'protocol agent', 'Plans laboratory protocols end to end', ?, '', '[]', 'claude', '2026-08-03T07:20:55.846Z', '2026-08-03T07:20:55.846Z')",
  ).run(id, EMAIL, JSON.stringify([skill]));
  return id;
}

describe("the starter Protocol Agent", () => {
  it("is delivered to an account that has none", async () => {
    expect(await svc.ensureStarterAgents(EMAIL)).toBe("created");
    const agents = await svc.listAgents(EMAIL);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("Protocol Agent");
    expect(agents[0]!.skillSlugs).toEqual([svc.PROTOCOL_AGENT_SKILL]);
  });

  it("is delivered once, not on every listing", async () => {
    await svc.ensureStarterAgents(EMAIL);
    expect(await svc.ensureStarterAgents(EMAIL)).toBe("unchanged");
    expect(await svc.listAgents(EMAIL)).toHaveLength(1);
  });

  it("stays deleted once the person deletes it", async () => {
    await svc.ensureStarterAgents(EMAIL);
    const [agent] = await svc.listAgents(EMAIL);
    await svc.deleteAgent(EMAIL, agent!.id);
    expect(await svc.ensureStarterAgents(EMAIL)).toBe("unchanged");
    expect(await svc.listAgents(EMAIL)).toHaveLength(0);
  });

  it("repairs a predecessor on the retired skill, keeping its id", async () => {
    const id = await plantLegacy();
    expect(await svc.ensureStarterAgents(EMAIL)).toBe("repaired");
    const agents = await svc.listAgents(EMAIL);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe(id);
    expect(agents[0]!.name).toBe("Protocol Agent");
    expect(agents[0]!.skillSlugs).toEqual([svc.PROTOCOL_AGENT_SKILL]);
    // The repair is a change other devices must learn about.
    expect(agents[0]!.updatedAt! > "2026-08-03T07:20:55.846Z").toBe(true);
  });

  it("repairs the user-folder spelling of the retired slug too", async () => {
    await plantLegacy("user--protocol-plan");
    expect(await svc.ensureStarterAgents(EMAIL)).toBe("repaired");
    expect((await svc.listAgents(EMAIL))[0]!.skillSlugs).toEqual([svc.PROTOCOL_AGENT_SKILL]);
  });

  it("keeps the predecessor's other skills when repairing", async () => {
    const { getDb } = await import("../src/services/db");
    const db = await getDb();
    db.prepare(
      "INSERT INTO agents (id, email, name, skill_slugs, working_dir, reference_folders, engine, created_at, updated_at) " +
        "VALUES ('mixed', ?, 'protocol agent', ?, '', '[]', 'claude', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')",
    ).run(EMAIL, JSON.stringify(["user--my-notes", "public--protocol-plan"]));
    await svc.ensureStarterAgents(EMAIL);
    expect((await svc.listAgents(EMAIL))[0]!.skillSlugs).toEqual(["user--my-notes", svc.PROTOCOL_AGENT_SKILL]);
  });

  it("does not add a twin beside an agent already on the new skill", async () => {
    await svc.createAgent(EMAIL, {
      name: "My protocol helper",
      skillSlugs: [svc.PROTOCOL_AGENT_SKILL],
      workingDir: path.join(dir, "work"),
      referenceFolders: [],
    });
    expect(await svc.ensureStarterAgents(EMAIL)).toBe("unchanged");
    expect(await svc.listAgents(EMAIL)).toHaveLength(1);
  });

  it("is carried to other devices by sync", async () => {
    await svc.ensureStarterAgents(EMAIL);
    const wire = await svc.listAgentsForSync(EMAIL);
    expect(wire.some((a) => a.name === "Protocol Agent" && a.skillSlugs.includes(svc.PROTOCOL_AGENT_SKILL))).toBe(true);
  });

  it("notifies the change listeners when it delivers or repairs", async () => {
    const seen: string[] = [];
    const off = svc.subscribeAgents((email) => seen.push(email));
    await svc.ensureStarterAgents(EMAIL);
    await svc.ensureStarterAgents(EMAIL);
    off();
    expect(seen).toEqual([EMAIL]);
  });
});

// The library MCP server, two ways: driven directly over stdio the way the
// claude CLI drives it, and through a real chat turn where the fake CLI reads
// the --mcp-config the turn builder passed, spawns the server from it and
// lists its tools.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyTestEnv, sleep, waitFor } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "mcp@example.com";
const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, "../src/bin.ts");

let server: TestServer;
let cookie: string;
let sealed: string;
let ownDir: string;

beforeAll(async () => {
  applyTestEnv("mcp");
  const root = process.env.SKILLS_ROOTS!;
  ownDir = path.join(root, "mcp-at-example-com", "protocols");
  fs.mkdirSync(path.join(ownDir, "Cloning"), { recursive: true });
  fs.writeFileSync(
    path.join(ownDir, "Cloning", "gibson.md"),
    "---\nname: Gibson assembly\ndescription: Join fragments by overlap.\nkind: protocol\ncategory: Cloning\n---\n## Reaction\n\n1. Combine the fragments.\n2. Incubate 1 hour at 50 C.\n",
  );
  const { sealSession } = await import("../src/services/session");
  sealed = await sealSession({ email: EMAIL });
  cookie = `monterey_session=${encodeURIComponent(sealed)}`;
  server = await startServer({
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: root,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
    LABEE_EMBED_PROVIDER: "fake",
  });
}, 30000);

afterAll(() => server?.stop());

/** A JSON-RPC client over the server's stdio, as the CLI would be. */
class McpClient {
  private proc: ChildProcess;
  private replies = new Map<number, { result?: unknown; error?: { message: string } }>();
  private buf = "";
  private nextId = 1;

  constructor(env: Record<string, string>) {
    this.proc = spawn("bun", [BIN, "--mcp-library"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d: Buffer) => {
      this.buf += d.toString();
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (typeof m.id === "number") this.replies.set(m.id, m);
      }
    });
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: { message: string } }> {
    const id = this.nextId++;
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await waitFor(() => this.replies.has(id), 10000);
    return this.replies.get(id)!;
  }

  notify(method: string): void {
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await this.call("tools/call", { name, arguments: args });
    const result = r.result as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0]!.text, isError: Boolean(result.isError) };
  }

  stop(): void {
    this.proc.stdin!.end();
    this.proc.kill();
  }
}

describe("library MCP over stdio", () => {
  let mcp: McpClient;
  beforeAll(() => {
    mcp = new McpClient({ LABEE_MCP_BASE: server.base, LABEE_MCP_COOKIE: sealed });
  });
  afterAll(() => mcp?.stop());

  it("initializes and lists its tools", async () => {
    const init = await mcp.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("labee-library");
    mcp.notify("notifications/initialized");
    const list = await mcp.call("tools/list");
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toEqual([
      "library_search", "library_get", "library_ask", "library_lint", "library_review", "library_order", "library_save",
    ]);
    expect((await mcp.call("ping")).result).toEqual({});
    expect((await mcp.call("no/such")).error?.message).toContain("Method not found");
  });

  it("searches, reads, lints, reviews and orders through the server, as the person", async () => {
    const search = JSON.parse((await mcp.tool("library_search", { q: "how long at 50 C" })).text) as {
      mode: string;
      hits: Array<{ slug: string; path: string; grain: string }>;
    };
    expect(search.hits[0]?.slug).toBe("user--gibson-assembly");
    expect(search.hits[0]?.grain).toBe("step");

    const got = JSON.parse((await mcp.tool("library_get", { slug: "user--gibson-assembly" })).text) as { name: string; body: string; category: string };
    expect(got.name).toBe("Gibson assembly");
    expect(got.category).toBe("Cloning");
    expect(got.body).toContain("Incubate 1 hour at 50 C");

    const lint = JSON.parse((await mcp.tool("library_lint", { markdown: "## P\n\n1. Spin at 50,000 rpm.\n" })).text) as { halts: number };
    expect(lint.halts).toBe(1);

    const review = JSON.parse((await mcp.tool("library_review", { markdown: "## P\n\n1. Spin at 50,000 rpm.\n", name: "x" })).text) as {
      findings: Array<{ path: string; class: string }>;
    };
    expect(review.findings[0]).toMatchObject({ path: "1.1", class: "parameter" });

    const order = JSON.parse((await mcp.tool("library_order", { steps: ["2. B", "1. A"] })).text) as { order: number[] };
    expect(order.order).toEqual([1, 0]);

    const bad = await mcp.tool("library_get", { slug: "user--nothing" });
    expect(bad.isError).toBe(true);
    const missing = await mcp.tool("library_search", {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("q is required");
  });

  it("saves a confirmed draft into the library, in its category, and it is searchable at once", async () => {
    const saved = JSON.parse(
      (
        await mcp.tool("library_save", {
          name: "Three-fragment Gibson",
          description: "Gibson assembly with three inserts.",
          markdown: "## Procedure\n\n1. Combine three fragments at equimolar ratio.\n2. Incubate 1 hour at 50 C.\n",
          category: "Cloning",
          problem: "Joining three fragments in one reaction.",
          domains: ["Cloning"],
        })
      ).text,
    ) as { ok: boolean; slug: string; file: string };
    expect(saved.ok).toBe(true);
    expect(saved.slug).toBe("user--three-fragment-gibson");
    expect(saved.file).toContain(path.join("Cloning", "three-fragment-gibson.md"));
    expect(fs.existsSync(saved.file)).toBe(true);
    expect(fs.readFileSync(saved.file, "utf8")).toContain("problem: Joining three fragments");
    await waitFor(async () => {
      const r = JSON.parse((await mcp.tool("library_search", { q: "three fragments equimolar" })).text) as { hits: Array<{ slug: string }> };
      return r.hits[0]?.slug === "user--three-fragment-gibson";
    }, 10000);
  });
});

describe("a read-only turn", () => {
  it("refuses to save and says why", async () => {
    const ro = new McpClient({ LABEE_MCP_BASE: server.base, LABEE_MCP_COOKIE: sealed, LABEE_MCP_READONLY: "1" });
    try {
      await ro.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      const r = await ro.tool("library_save", { name: "x", description: "y", markdown: "## P\n\n1. Go.\n" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("read-only");
      expect(fs.existsSync(path.join(ownDir, "x.md"))).toBe(false);
    } finally {
      ro.stop();
    }
  });
});

describe("through a chat turn", () => {
  it("passes the library server to the CLI, which can spawn it and list its tools", async () => {
    const api = (p: string, init: RequestInit = {}) =>
      fetch(`${server.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
    const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "mcp" }) });
    expect(created.status).toBe(201);
    const { session: { id } } = (await created.json()) as { session: { id: string } };
    const turn = await api(`/api/sessions/${id}/turns`, { method: "POST", body: JSON.stringify({ text: "[[mcp]] hello", runMode: "build" }) });
    expect([200, 202]).toContain(turn.status);
    let text = "";
    await waitFor(async () => {
      const r = (await (await api(`/api/sessions/${id}`)).json()) as { messages: Array<{ role: string; content: string }> };
      const last = r.messages.filter((m) => m.role === "assistant").pop();
      text = last?.content ?? "";
      return text.includes("servers:");
    }, 20000);
    expect(text).toContain("servers: library");
    expect(text).toContain("library tools: 7");
    expect(text).toContain("library search: ok");
    await sleep(50);
  }, 30000);
});

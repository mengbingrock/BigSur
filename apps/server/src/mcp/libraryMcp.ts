// The library MCP server: the protocol library as tools for the agent.
//
// Spawned by the claude CLI as a stdio server for each chat turn (see
// services/libraryMcp.ts for the wiring), it speaks MCP's JSON-RPC over
// stdin/stdout and answers every tool call by calling this server's own HTTP
// API, as the person whose turn it is. So the agent searches, lints, reviews,
// orders and saves through exactly the same code the pages use, with the same
// account scoping, and nothing here duplicates a service.
//
// Four methods are all MCP needs: initialize, tools/list, tools/call, ping.
// Deliberately no SDK — the protocol is small and the dependency is not.
import readline from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "library_search",
    description:
      "Search the person's own protocols (and skills) by meaning and by words. Returns one row per " +
      "protocol with the best-matching passage: slug, heading, path (\"2.3\" is section 2, step 3), " +
      "grain (section / step / summary) and a snippet. Use before writing anything: their own " +
      "protocols are the first source of truth.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "What to look for — a question, a parameter, a technique." },
        kind: { type: "string", enum: ["protocol", "skill"], description: "Default protocol." },
        limit: { type: "integer", description: "Default 10." },
      },
      required: ["q"],
    },
  },
  {
    name: "library_get",
    description: "Read one protocol in full by slug: name, description, category, purpose fields and the markdown body.",
    inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
  },
  {
    name: "library_ask",
    description:
      "Ask a question and get an answer drawn only from the person's protocols, with numbered " +
      "citations (slug, heading, path) and the model's confidence.",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
  {
    name: "library_lint",
    description:
      "Mechanical checks on a protocol draft (markdown): numbers without units, reagents a step uses " +
      "that are not under Materials, numbering gaps, empty sections, physically impossible values " +
      "(a halt). Run on every draft before showing it; fix every halt.",
    inputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
  },
  {
    name: "library_review",
    description:
      "Scientific review of a protocol draft (markdown): each step judged with its purpose and " +
      "neighbours against this lab's other protocols, for an operation that is wrong or out of order, " +
      "a reagent that is wrong or missing, or a parameter inconsistent with context. Returns findings " +
      "by step path with a suggestion and confidence.",
    inputSchema: {
      type: "object",
      properties: {
        markdown: { type: "string" },
        name: { type: "string", description: "The draft's name, for context." },
        description: { type: "string" },
      },
      required: ["markdown"],
    },
  },
  {
    name: "library_order",
    description: "Put a list of protocol steps in the order they should run. Returns the permutation and the reordered steps.",
    inputSchema: {
      type: "object",
      properties: { steps: { type: "array", items: { type: "string" } }, title: { type: "string" } },
      required: ["steps"],
    },
  },
  {
    name: "library_save",
    description:
      "Save a finished protocol into the person's library as a new protocol. Only after they have " +
      "confirmed the draft. `markdown` is the body (sections and numbered steps; no frontmatter — " +
      "name, description and purpose fields are separate arguments). Returns the slug.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string", description: "One sentence: what it achieves and the key condition." },
        markdown: { type: "string", description: "The body: ## Materials, ## Procedure with numbered steps, ## Notes, ## References." },
        category: { type: "string", description: "Folder, e.g. Cloning. Created if new." },
        problem: { type: "string" },
        method: { type: "string" },
        application: { type: "string" },
        domains: { type: "array", items: { type: "string" } },
        keywords: { type: "array", items: { type: "string" } },
      },
      required: ["name", "description", "markdown"],
    },
  },
];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; the library MCP must be spawned by the Labee server.`);
  return v;
}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env("LABEE_MCP_BASE").replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      cookie: `monterey_session=${env("LABEE_MCP_COOKIE")}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required.`);
  return v;
};

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "library_search": {
      const q = str(args.q, "q");
      const kind = args.kind === "skill" ? "skill" : "protocol";
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 10;
      return api("GET", `/api/skills/search?kind=${kind}&limit=${limit}&q=${encodeURIComponent(q)}`);
    }
    case "library_get": {
      const slug = str(args.slug, "slug");
      const r = await api<{ skill: Record<string, unknown> }>("GET", `/api/skills/${encodeURIComponent(slug)}`);
      const s = r.skill;
      return {
        slug: s.slug, name: s.name, description: s.description, category: s.category ?? null,
        problem: s.problem ?? null, method: s.method ?? null, application: s.application ?? null,
        domains: s.domains ?? [], keywords: s.keywords ?? [], body: s.body,
      };
    }
    case "library_ask":
      return api("POST", "/api/skills/ask", { q: str(args.q, "q"), kind: "protocol" });
    case "library_lint":
      return api("POST", "/api/skills/lint", { markdown: str(args.markdown, "markdown") });
    case "library_review":
      return api("POST", "/api/skills/review", {
        markdown: str(args.markdown, "markdown"),
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
      });
    case "library_order": {
      const steps = Array.isArray(args.steps) ? args.steps.filter((s): s is string => typeof s === "string") : null;
      if (!steps) throw new Error("steps is required.");
      return api("POST", "/api/skills/order", { steps, ...(typeof args.title === "string" ? { title: args.title } : {}) });
    }
    case "library_save": {
      if (process.env.LABEE_MCP_READONLY === "1") {
        throw new Error("This turn is read-only (chat or plan mode). Show the draft and ask the person to switch to build mode to save it.");
      }
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
      const created = await api<{ skill: { slug: string; sourcePath: string; artifactFile?: string } }>("POST", "/api/skills", {
        name: str(args.name, "name"),
        description: str(args.description, "description"),
        allowedTools: [],
        body: str(args.markdown, "markdown"),
        kind: "protocol",
        ...(typeof args.problem === "string" ? { problem: args.problem } : {}),
        ...(typeof args.method === "string" ? { method: args.method } : {}),
        ...(typeof args.application === "string" ? { application: args.application } : {}),
        ...(list(args.domains) ? { domains: list(args.domains) } : {}),
        ...(list(args.keywords) ? { keywords: list(args.keywords) } : {}),
      });
      let slug = created.skill.slug;
      let file = created.skill.artifactFile ?? created.skill.sourcePath;
      if (typeof args.category === "string" && args.category.trim()) {
        const moved = await api<{ skill: { slug: string; sourcePath: string; artifactFile?: string } }>(
          "POST",
          `/api/skills/${encodeURIComponent(slug)}/move`,
          { category: args.category.trim() },
        );
        slug = moved.skill.slug;
        file = moved.skill.artifactFile ?? moved.skill.sourcePath;
      }
      return { ok: true, slug, file };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function write(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg: Rpc): Promise<void> {
  const { id, method, params = {} } = msg;
  const reply = (result: unknown) => {
    if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, result });
  };
  const fail = (code: number, message: string) => {
    if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, error: { code, message } });
  };
  switch (method) {
    case "initialize":
      reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "labee-library", version: "1" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools: TOOLS });
      return;
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(name, args);
        reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
      return;
    }
    default:
      if (method?.startsWith("notifications/")) return;
      fail(-32601, `Method not found: ${method}`);
  }
}

/** Serve MCP over stdio until stdin closes. */
export async function serveLibraryMcp(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(text) as Rpc;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    await handle(msg);
  }
}

/** For tests and tooling: the tool names this server offers. */
export const LIBRARY_TOOL_NAMES = TOOLS.map((t) => t.name);

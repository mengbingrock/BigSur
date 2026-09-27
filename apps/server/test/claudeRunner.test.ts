import { describe, expect, it } from "vitest";
import { buildClaudeArgs, childEnv, extractLastJson, runClaudeJson } from "../src/services/claudeRunner";

/** Read the (single) value following a flag in an argv array. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("buildClaudeArgs", () => {
  it("builds the chat-shaped stream-json argv", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      systemPrompt: "sys",
      model: "opus",
      tools: "default",
      outputFormat: "stream-json",
      permissionMode: "bypassPermissions",
      settingSources: "project,user",
      excludeDynamicSystemPromptSections: true,
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
      mcpArgs: ["--mcp-config", "{}"],
      chrome: true,
      effort: "high",
    });
    expect(flagValue(args, "-p")).toBe("hi");
    expect(flagValue(args, "--system-prompt")).toBe("sys");
    expect(flagValue(args, "--model")).toBe("opus");
    expect(flagValue(args, "--tools")).toBe("default");
    expect(flagValue(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(flagValue(args, "--permission-mode")).toBe("bypassPermissions");
    expect(args).toContain("--no-session-persistence");
    expect(flagValue(args, "--setting-sources")).toBe("project,user");
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
    // disallowedTools are positional values after the single flag
    const dt = args.indexOf("--disallowedTools");
    expect(args.slice(dt + 1, dt + 6)).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
    expect(flagValue(args, "--mcp-config")).toBe("{}");
    expect(args).toContain("--chrome");
    expect(flagValue(args, "--effort")).toBe("high");
  });

  it("builds the one-shot text argv without stream flags or optional sections", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      systemPrompt: "sys",
      model: "haiku",
      tools: "",
      outputFormat: "text",
      permissionMode: "bypassPermissions",
      effort: "low",
    });
    expect(flagValue(args, "--tools")).toBe("");
    expect(flagValue(args, "--output-format")).toBe("text");
    expect(args).not.toContain("--verbose");
    expect(args).not.toContain("--include-partial-messages");
    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--chrome");
    expect(args).toContain("--no-session-persistence");
  });
});

describe("extractLastJson", () => {
  it("takes the last fenced json block", () => {
    const text = 'first ```json\n{"a":1}\n``` then ```json\n{"b":2}\n``` done';
    expect(extractLastJson(text)).toEqual({ b: 2 });
  });
  it("accepts an unfenced pure-JSON body", () => {
    expect(extractLastJson('  {"x": [1,2]} ')).toEqual({ x: [1, 2] });
  });
  it("prefers the fence over surrounding prose", () => {
    const text = 'Here you go:\n```json\n{"ok":true}\n```\nAnything else?';
    expect(extractLastJson(text)).toEqual({ ok: true });
  });
  it("returns null when nothing parses", () => {
    expect(extractLastJson("no json here")).toBeNull();
  });
});

describe("runClaudeJson", () => {
  const baseOpts = {
    prompt: "count",
    systemPrompt: "sys",
    model: "haiku",
    effort: "low" as const,
    timeoutMs: 1000,
  };

  it("returns the validated value on first success", async () => {
    const result = await runClaudeJson(
      baseOpts,
      (u) => {
        if (typeof (u as { n?: unknown }).n !== "number") throw new Error("n must be a number");
        return u as { n: number };
      },
      2,
      async () => '```json\n{"n": 3}\n```',
    );
    expect(result).toEqual({ n: 3 });
  });

  it("retries with the validation error appended, then succeeds", async () => {
    const prompts: string[] = [];
    let call = 0;
    const result = await runClaudeJson(
      baseOpts,
      (u) => {
        if (typeof (u as { n?: unknown }).n !== "number") throw new Error("n must be a number");
        return u as { n: number };
      },
      2,
      async (o) => {
        prompts.push(o.prompt);
        call++;
        return call === 1 ? '```json\n{"n": "three"}\n```' : '```json\n{"n": 3}\n```';
      },
    );
    expect(result).toEqual({ n: 3 });
    expect(prompts[0]).toBe("count");
    expect(prompts[1]).toContain("n must be a number");
  });

  it("throws after maxAttempts failures", async () => {
    await expect(
      runClaudeJson(
        baseOpts,
        () => {
          throw new Error("nope");
        },
        2,
        async () => "{}",
      ),
    ).rejects.toThrow(/after 2 attempts: nope/);
  });
});

describe("childEnv", () => {
  /** Set vars for one test and restore whatever was there before. */
  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("drops the session a parent Claude Code launched us from", () => {
    // Launching the server from inside a Claude Code session used to leak these
    // into the CLI, which then reported "another auth source is set", disabled
    // the user's claude.ai connectors and exited 1 without doing any work.
    const env = withEnv(
      {
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_SESSION_ID: "abc123",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "tok",
        CLAUDE_CODE_EXECPATH: "/usr/bin/claude",
      },
      () => childEnv(),
    );
    for (const key of [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_EXECPATH",
    ]) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it("keeps configuration the operator set on purpose", () => {
    const env = withEnv(
      {
        CLAUDECODE: "1",
        ANTHROPIC_API_KEY: "sk-ant-deliberate",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_BIN: "/opt/claude",
      },
      () => childEnv(),
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-deliberate");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.CLAUDE_BIN).toBe("/opt/claude");
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("lets the caller add to and override the environment", () => {
    const env = withEnv({ CLAUDECODE: "1", LABEE_MODE: "desktop" }, () =>
      childEnv({ LABEE_MODE: "server", EXTRA: "x" }),
    );
    expect(env.LABEE_MODE).toBe("server");
    expect(env.EXTRA).toBe("x");
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("does not mutate process.env", () => {
    withEnv({ CLAUDECODE: "1" }, () => {
      childEnv();
      expect(process.env.CLAUDECODE).toBe("1");
    });
  });
});

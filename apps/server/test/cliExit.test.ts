import { describe, expect, it } from "vitest";
import { cliExitMessage, meaningfulStderr, resultErrorOf } from "../src/services/cliExit";

const CONNECTORS =
  "\x1b[33m⚠\x1b[0m claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set. " +
  "To use connectors, unset it and sign in.\n";

describe("cliExitMessage", () => {
  it("prefers the CLI's error result over the connectors warning", () => {
    const msg = cliExitMessage({
      code: 1,
      stderr: CONNECTORS,
      resultError: 'API Error: 503 {"error":"Labee has no anthropic account configured on this server."}',
      route: { kind: "proxy", host: "labee.online" },
    });
    expect(msg).not.toMatch(/connectors/);
    expect(msg).toContain("claude CLI exited with code 1 (Labee provided via labee.online)");
    expect(msg).toContain("API Error: 503");
    expect(msg).toContain("Switch this provider to your own account under Settings → Connection");
  });

  it("falls back to the last meaningful stderr lines, without ANSI", () => {
    const msg = cliExitMessage({
      code: 1,
      stderr: CONNECTORS + "\x1b[31mError: Not logged in. Run `claude login`.\x1b[0m\n",
      route: { kind: "own_subscription" },
    });
    expect(msg).toBe(
      "claude CLI exited with code 1 (your Claude subscription on this machine): " +
        "Error: Not logged in. Run `claude login`. — Run `claude` in a terminal on this machine and sign in, then retry.",
    );
  });

  it("says so when there is nothing to report", () => {
    expect(cliExitMessage({ code: 1, stderr: CONNECTORS })).toBe(
      "claude CLI exited with code 1 with no error output",
    );
  });

  it("names a timeout and a kill", () => {
    expect(cliExitMessage({ code: null, stderr: "", timedOut: true })).toMatch(/^claude CLI timed out/);
    expect(cliExitMessage({ code: null, stderr: "" })).toMatch(/^claude CLI was killed/);
  });

  it("gives the API-key hint on an auth failure", () => {
    const msg = cliExitMessage({
      code: 1,
      stderr: "",
      resultError: "API Error: 401 authentication_error: invalid x-api-key",
      route: { kind: "own_api_key" },
    });
    expect(msg).toContain("(your API key)");
    expect(msg).toContain("Check the API key under Settings → Connection.");
  });

  it("clips a very long cause", () => {
    const msg = cliExitMessage({ code: 1, stderr: "", resultError: "x".repeat(2000) });
    expect(msg.length).toBeLessThan(500);
    expect(msg.endsWith("…")).toBe(true);
  });
});

describe("meaningfulStderr", () => {
  it("drops blanks, the warning glyph and the connectors notice", () => {
    expect(meaningfulStderr(`${CONNECTORS}\n⚠\n\nreal problem here\n`)).toEqual(["real problem here"]);
  });
});

describe("resultErrorOf", () => {
  it("returns the result text only for error results", () => {
    expect(resultErrorOf({ type: "result", is_error: true, result: "API Error: 503" })).toBe("API Error: 503");
    expect(resultErrorOf({ type: "result", is_error: false, result: "fine" })).toBeNull();
    expect(resultErrorOf({ type: "assistant" })).toBeNull();
  });

  it("uses the errors list or subtype when there is no text", () => {
    expect(resultErrorOf({ type: "result", is_error: true, errors: ["a", "b"] })).toBe("a | b");
    expect(resultErrorOf({ type: "result", is_error: true, subtype: "error_max_turns" })).toBe("error_max_turns");
  });
});

import { describe, expect, it } from "vitest";
import { mcpCallCounts } from "../src/routes/protocolsMcp";

describe("protocol MCP request classification", () => {
  it("does not meter MCP bootstrap traffic", () => {
    expect(mcpCallCounts(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }))).toEqual({ searches: 0, toolCalls: 0 });
    expect(mcpCallCounts(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }))).toEqual({ searches: 0, toolCalls: 0 });
    expect(mcpCallCounts(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }))).toEqual({ searches: 0, toolCalls: 0 });
  });

  it("meters tool calls and counts searches for credit charging", () => {
    expect(mcpCallCounts(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fetch", arguments: { id: "doi:10.1/example" } },
    }))).toEqual({ searches: 0, toolCalls: 1 });
    expect(mcpCallCounts(JSON.stringify([
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "search", arguments: { query: "PCR" } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "fetch", arguments: { id: "doi:10.1/example" } },
      },
    ]))).toEqual({ searches: 1, toolCalls: 2 });
  });

  it("treats malformed input as non-metered so the upstream can reject it", () => {
    expect(mcpCallCounts("not-json")).toEqual({ searches: 0, toolCalls: 0 });
  });
});

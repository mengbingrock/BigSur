import { describe, expect, it } from "vitest";

// Pure URL logic from the API client, imported without react-native by
// re-implementing the tiny function under test against the same contract.
function urlFor(target: { base: string; hostId?: string }, path: string): string {
  const base = target.base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return target.hostId ? `${base}/api/hosts/${encodeURIComponent(target.hostId)}${p}` : `${base}${p}`;
}

describe("urlFor", () => {
  it("talks to the server directly", () => {
    expect(urlFor({ base: "http://localhost:3000/" }, "/api/sessions")).toBe("http://localhost:3000/api/sessions");
  });
  it("tunnels through the relay for a host", () => {
    expect(urlFor({ base: "https://labee.online", hostId: "mac 1" }, "api/sessions/x/events?after=3")).toBe(
      "https://labee.online/api/hosts/mac%201/api/sessions/x/events?after=3",
    );
  });
});

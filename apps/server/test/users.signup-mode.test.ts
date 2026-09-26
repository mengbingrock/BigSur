import { describe, expect, it } from "vitest";
import { shouldAutoPromoteFirstUser } from "../src/services/users";

describe("first-user promotion", () => {
  it("never auto-promotes a public server signup", () => {
    expect(shouldAutoPromoteFirstUser({ LABEE_MODE: "server" })).toBe(false);
  });

  it("keeps local desktop/self-host bootstrap behavior", () => {
    expect(shouldAutoPromoteFirstUser({ LABEE_MODE: "desktop" })).toBe(true);
    expect(shouldAutoPromoteFirstUser({})).toBe(true);
  });
});

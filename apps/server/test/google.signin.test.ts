import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { readStateCookie } from "../src/services/google";
import { readSession } from "../src/services/session";

vi.mock("../src/services/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/google")>()),
  exchangeCode: vi.fn(async () => ({ accessToken: "fixture-token" })),
  fetchProfile: vi.fn(async () => ({
    sub: "fixture",
    email: "fixture@example.test",
    emailVerified: true,
  })),
}));
vi.mock("../src/services/users", () => ({
  shouldAutoPromoteFirstUser: () => false,
  upsertGoogleUser: async () => ({
    email: "fixture@example.test",
    isAdmin: false,
  }),
}));
vi.mock("../src/services/billing", () => ({
  grantSignupCredits: async () => {},
}));

let app: ReturnType<typeof HttpRouter.toWebHandler>;
beforeAll(async () => {
  const { googleRoutes } = await import("../src/routes/google");
  app = HttpRouter.toWebHandler(Layer.mergeAll(...googleRoutes), {
    disableLogger: true,
  });
});
afterAll(async () => {
  await app?.dispose();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function configure(callback = "https://labee.online/api/auth/google/callback") {
  vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-secret");
  vi.stubEnv("GOOGLE_REDIRECT_URI", callback);
  vi.stubEnv(
    "SESSION_PASSWORD",
    "fixture-session-password-at-least-32-characters",
  );
  vi.stubEnv("COOKIE_SECURE", "false");
}
function request(url: string, cookie?: string) {
  const target = new URL(url);
  return app.handler(
    new Request(url, {
      headers: {
        host: target.host,
        "x-forwarded-proto": target.protocol.slice(0, -1),
        ...(cookie ? { cookie } : {}),
      },
    }),
  );
}

describe("Google sign-in origin and state", () => {
  it.each([
    ["https://www.labee.online", "https://labee.online"],
    ["http://127.0.0.1:5847", "http://localhost:5733"],
  ])(
    "moves %s to %s before creating the state cookie",
    async (start, canonical) => {
      configure(`${canonical}/api/auth/google/callback`);
      const params = new URLSearchParams({
        next: "/protocols",
        desktop: "http://127.0.0.1:4567/auth",
        mobile: "labee://auth",
      });
      const first = await request(`${start}/api/auth/google?${params}`);
      expect(first.status).toBe(302);
      expect(first.headers.get("set-cookie")).toBeNull();
      expect(first.headers.get("location")).toBe(
        `${canonical}/api/auth/google?${params}`,
      );
      const second = await request(first.headers.get("location")!);
      const google = new URL(second.headers.get("location")!);
      expect(google.origin).toBe("https://accounts.google.com");
      const saved = await readStateCookie(second.headers.get("set-cookie")!);
      expect(saved).toMatchObject({
        state: google.searchParams.get("state"),
        next: "/protocols",
        redirectUri: `${canonical}/api/auth/google/callback`,
        desktop: params.get("desktop"),
        mobile: params.get("mobile"),
      });
    },
  );

  it("completes a first sign-in with the cookie issued on the callback origin", async () => {
    configure();
    const start = await request(
      "https://labee.online/api/auth/google?next=%2Fprotocols",
    );
    const google = new URL(start.headers.get("location")!);
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const result = await request(
      `https://labee.online/api/auth/google/callback?code=fixture&state=${google.searchParams.get("state")}`,
      cookie,
    );
    expect(result.headers.get("location")).toBe("/protocols");
    expect(await readSession(result.headers.get("set-cookie")!)).toMatchObject({
      email: "fixture@example.test",
    });
  });

  it.each(["missing", "mismatched"])(
    "still rejects %s state cookies",
    async (kind) => {
      configure();
      const start = await request("https://labee.online/api/auth/google");
      const cookie =
        kind === "missing"
          ? undefined
          : start.headers.get("set-cookie")!.split(";")[0];
      const result = await request(
        "https://labee.online/api/auth/google/callback?code=fixture&state=wrong",
        cookie,
      );
      expect(result.headers.get("location")).toContain(
        "could%20not%20be%20verified",
      );
      const { exchangeCode } = await import("../src/services/google");
      expect(exchangeCode).not.toHaveBeenCalled();
    },
  );

  it("keeps derived desktop loopback origins working", async () => {
    configure("");
    const result = await request("http://127.0.0.1:4567/api/auth/google");
    const google = new URL(result.headers.get("location")!);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:4567/api/auth/google/callback",
    );
  });
});

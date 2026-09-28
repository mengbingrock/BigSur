// Turn a failed `claude` CLI run into an error message that names the real
// cause. The CLI's stderr is mostly noise (ANSI colour, a "connectors are
// disabled" notice whenever a key is set) and the real reason usually arrives
// on stdout as the final `result` event with `is_error: true` — e.g.
// "API Error: 503 …" from the inference proxy. Prefer that, then the last
// meaningful stderr lines, and add a hint tied to where inference was routed.

/** Where this turn's inference was sent, for the message and the hint. */
export type CliRoute =
  | { kind: "proxy"; host: string }
  | { kind: "own_api_key" }
  | { kind: "own_subscription" }
  | { kind: "provided" };

export interface CliExit {
  code: number | null;
  stderr: string;
  /** Text of the CLI's final `result` event when it flagged `is_error`. */
  resultError?: string | null | undefined;
  route?: CliRoute | undefined;
  timedOut?: boolean | undefined;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** stderr lines that never explain a failure. */
const BENIGN = [
  /claude\.ai connectors are disabled/i,
  /^Warning: no stdin data received/i,
  /^\s*[⚠!]\s*$/,
  /^\s*$/,
];

const MAX_CAUSE = 400;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Last stderr lines that could explain the exit, oldest first. */
export function meaningfulStderr(stderr: string, keep = 3): string[] {
  return stripAnsi(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !BENIGN.some((re) => re.test(l)))
    .slice(-keep);
}

function routeLabel(route: CliRoute | undefined): string | null {
  switch (route?.kind) {
    case "proxy":
      return `Labee provided via ${route.host}`;
    case "own_api_key":
      return "your API key";
    case "own_subscription":
      return "your Claude subscription on this machine";
    case "provided":
      return "Labee provided";
    default:
      return null;
  }
}

function hintFor(cause: string, route: CliRoute | undefined): string | null {
  const upstreamDown = /\b(502|503|504|529)\b|overloaded|ECONNREFUSED|ENOTFOUND|fetch failed|unavailable/i.test(cause);
  const authFailed = /\b(401|403)\b|authentication|invalid (api )?key|not logged in|login|OAuth|expired/i.test(cause);
  const rateLimited = /\b429\b|rate.?limit|usage limit|quota/i.test(cause);
  switch (route?.kind) {
    case "proxy":
      if (upstreamDown)
        return `Labee's provided Claude account isn't available on ${route.host} right now. Switch this provider to your own account under Settings → Connection, or try again later.`;
      if (authFailed)
        return `Your Labee sign-in on this device may have expired. Sign in again under Settings → Connection and retry.`;
      if (rateLimited) return `The provided account is over its limit. Try again later or use your own account under Settings → Connection.`;
      return null;
    case "own_api_key":
      if (authFailed) return "Check the API key under Settings → Connection.";
      if (rateLimited) return "Your API key is over its rate limit or credit. Check the account's usage.";
      return null;
    case "own_subscription":
      if (authFailed) return "Run `claude` in a terminal on this machine and sign in, then retry.";
      if (rateLimited) return "Your Claude subscription has hit its usage limit. Wait for it to reset or use another account.";
      return null;
    case "provided":
      if (authFailed || upstreamDown) return "Ask the operator to check the provided Claude account on this server.";
      return null;
    default:
      return null;
  }
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_CAUSE ? `${t.slice(0, MAX_CAUSE - 1)}…` : t;
}

/** The `error` message for a CLI run that did not exit 0. */
export function cliExitMessage(exit: CliExit): string {
  const label = routeLabel(exit.route);
  const via = label ? ` (${label})` : "";
  const how = exit.timedOut
    ? "timed out"
    : exit.code === null
      ? "was killed"
      : `exited with code ${exit.code}`;
  const head = `claude CLI ${how}${via}`;

  const fromResult = exit.resultError?.trim();
  const tail = meaningfulStderr(exit.stderr);
  const cause = fromResult ? clip(fromResult) : tail.length ? clip(tail.join(" | ")) : "";
  const hint = cause ? hintFor(cause, exit.route) : null;

  const parts = [cause ? `${head}: ${cause}` : `${head} with no error output`];
  if (hint) parts.push(hint);
  return parts.join(" — ");
}

/** The CLI's final `result` event text when it reports an error, else null. */
export function resultErrorOf(evt: Record<string, unknown>): string | null {
  if (evt.type !== "result" || !evt.is_error) return null;
  const r = evt.result;
  if (typeof r === "string" && r.trim()) return r;
  if (Array.isArray(evt.errors) && evt.errors.length) return evt.errors.map(String).join(" | ");
  return typeof evt.subtype === "string" ? evt.subtype : "unknown error";
}

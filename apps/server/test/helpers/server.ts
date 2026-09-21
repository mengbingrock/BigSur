// Boot a real server (bun) on a free port for HTTP-level tests.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./env";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, "../..");

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface TestServer {
  port: number;
  base: string;
  proc: ChildProcess;
  stop: () => void;
  logs: string[];
}

export async function startServer(env: NodeJS.ProcessEnv, opts: { port?: number } = {}): Promise<TestServer> {
  const port = opts.port ?? (await freePort());
  const logs: string[] = [];
  const proc = spawn("bun", ["run", "src/bin.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env, LABEE_PORT: String(port), LABEE_HOST: "127.0.0.1", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tap = (s: NodeJS.ReadableStream) => s.on("data", (d: Buffer) => logs.push(d.toString()));
  if (proc.stdout) tap(proc.stdout);
  if (proc.stderr) tap(proc.stderr);
  const base = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try {
      const r = await fetch(`${base}/api/me`);
      if (r.status < 500) break;
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) throw new Error(`server exited: ${logs.join("")}`);
    await sleep(100);
  }
  return {
    port,
    base,
    proc,
    logs,
    stop: () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // gone
      }
    },
  };
}

/** Read an SSE response until `until(frame)` returns true or the body ends. */
export async function readSse(
  res: Response,
  until: (frame: { event: string; data: Record<string, unknown>; id?: string }) => boolean,
  timeoutMs = 10000,
): Promise<{ event: string; data: Record<string, unknown>; id?: string }[]> {
  const frames: { event: string; data: Record<string, unknown>; id?: string }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        sleep(Math.max(deadline - Date.now(), 0)).then(() => ({ value: undefined, done: true as const })),
      ]);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      let stop = false;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        let id: string | undefined;
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          else if (line.startsWith("id:")) id = line.slice(3).trim();
        }
        if (data.length === 0) continue;
        const frame = { event, data: JSON.parse(data.join("\n")) as Record<string, unknown>, ...(id ? { id } : {}) };
        frames.push(frame);
        if (until(frame)) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return frames;
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getWorkspaceDir, isWorkspaceId } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXT_CONTENT_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

export async function GET(
  _req: Request,
  { params }: { params: { workspace: string; file: string[] } },
) {
  const workspaceId = params.workspace;
  if (!isWorkspaceId(workspaceId)) {
    return Response.json({ error: "invalid workspace id" }, { status: 400 });
  }
  const dir = getWorkspaceDir(workspaceId);
  if (!dir) {
    return Response.json(
      { error: "workspace not found (expired or never existed)" },
      { status: 404 },
    );
  }

  const rel = path.posix.join(...params.file);
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
    return Response.json({ error: "invalid file path" }, { status: 400 });
  }

  // Resolve and re-check containment to block traversal via symlinks.
  const absolute = path.resolve(dir, rel);
  const realDir = await fsp.realpath(dir).catch(() => null);
  if (!realDir) {
    return Response.json({ error: "workspace unreadable" }, { status: 500 });
  }
  const realAbs = await fsp.realpath(absolute).catch(() => null);
  if (!realAbs || !realAbs.startsWith(realDir + path.sep)) {
    return Response.json({ error: "path escapes workspace" }, { status: 403 });
  }

  // Refuse to serve anything under .claude/ (skill symlinks).
  if (rel.startsWith(".claude/") || rel === ".claude") {
    return Response.json({ error: "reserved path" }, { status: 403 });
  }

  let stat: import("node:fs").Stats;
  try {
    stat = await fsp.stat(realAbs);
  } catch {
    return Response.json({ error: "file not found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return Response.json({ error: "not a file" }, { status: 400 });
  }

  const ext = path.extname(realAbs).toLowerCase();
  const contentType = EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";
  const filename = path.basename(realAbs);
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_");
  const disposition =
    `attachment; filename="${asciiFallback.replace(/"/g, "\\\"")}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`;

  // Stream the file body so we don't buffer huge outputs in memory.
  const nodeStream = fs.createReadStream(realAbs);
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(buf));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    },
  });
}

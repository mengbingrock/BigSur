import { NextRequest } from "next/server";
import { getCurrentEmail } from "@/lib/session";
import { deleteDeckFile, readDeckFile } from "@/lib/deck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

function contentTypeFor(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  return CONTENT_TYPES[name.slice(idx).toLowerCase()] ?? "application/octet-stream";
}

function rfc5987Encode(s: string): string {
  return encodeURIComponent(s).replace(/['()]/g, escape).replace(/\*/g, "%2A");
}

function statusFor(err: unknown): number {
  const code = (err as { code?: string } | null)?.code;
  if (code === "NOT_FOUND") return 404;
  if (code === "BAD_NAME" || code === "PATH_ESCAPE") return 400;
  return 500;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { file: string } },
) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let filename: string;
  try {
    filename = decodeURIComponent(params.file);
  } catch {
    return Response.json({ error: "Invalid filename." }, { status: 400 });
  }

  try {
    const { data, size, modified } = await readDeckFile(email, filename);
    const ct = contentTypeFor(filename);
    const wantInline = req.nextUrl.searchParams.get("inline") === "1";
    const disposition = `${wantInline ? "inline" : "attachment"}; filename*=UTF-8''${rfc5987Encode(filename)}`;
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Content-Length": String(size),
        "Content-Disposition": disposition,
        "Last-Modified": new Date(modified).toUTCString(),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error.";
    return Response.json({ error: msg }, { status: statusFor(err) });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { file: string } },
) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let filename: string;
  try {
    filename = decodeURIComponent(params.file);
  } catch {
    return Response.json({ error: "Invalid filename." }, { status: 400 });
  }

  try {
    await deleteDeckFile(email, filename);
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed.";
    return Response.json({ error: msg }, { status: statusFor(err) });
  }
}

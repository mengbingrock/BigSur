import { NextRequest } from "next/server";
import { getCurrentEmail } from "@/lib/session";
import {
  getMaxUploadBytes,
  listDeck,
  saveDeckFile,
  type DeckFile,
} from "@/lib/deck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UploadResult {
  uploaded: DeckFile[];
  failed: { name: string; error: string }[];
}

export async function GET() {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const files = await listDeck(email);
  return Response.json({
    files,
    maxUploadBytes: getMaxUploadBytes(),
  });
}

export async function POST(req: NextRequest) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    return Response.json(
      { error: "Expected multipart/form-data upload." },
      { status: 400 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not parse upload.";
    return Response.json({ error: msg }, { status: 400 });
  }

  const result: UploadResult = { uploaded: [], failed: [] };
  // Accept any file field (any name); browsers default to "file" but we don't
  // require it. Skip non-File entries silently.
  for (const [, value] of form.entries()) {
    if (typeof value === "string") continue;
    const file = value as File;
    if (!file.name) {
      result.failed.push({ name: "(unnamed)", error: "Missing filename." });
      continue;
    }
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const saved = await saveDeckFile(email, file.name, buf);
      result.uploaded.push(saved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed.";
      result.failed.push({ name: file.name, error: msg });
    }
  }

  if (result.uploaded.length === 0 && result.failed.length === 0) {
    return Response.json(
      { error: "No files were included in the upload." },
      { status: 400 },
    );
  }

  // 201 on full success, 207 on partial, 400 if every file failed.
  let status = 201;
  if (result.uploaded.length === 0) status = 400;
  else if (result.failed.length > 0) status = 207;
  return Response.json(result, { status });
}

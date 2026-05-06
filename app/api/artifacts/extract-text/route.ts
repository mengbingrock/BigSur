import { NextRequest } from "next/server";
import { getCurrentEmail } from "@/lib/session";
import {
  extractTextFromBuffer,
  UnsupportedFormatError,
} from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

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
  } catch {
    return Response.json({ error: "Could not parse upload." }, { status: 400 });
  }

  const value = form.get("file");
  if (!value || typeof value === "string") {
    return Response.json({ error: "Missing file." }, { status: 400 });
  }
  const file = value as File;
  if (!file.name) {
    return Response.json({ error: "Missing filename." }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return Response.json(
      {
        error: `File is ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB — exceeds 25 MB limit.`,
      },
      { status: 413 },
    );
  }

  try {
    const result = await extractTextFromBuffer(buf, file.name);
    return Response.json({
      text: result.text,
      filename: file.name,
      format: result.format,
    });
  } catch (err) {
    if (err instanceof UnsupportedFormatError) {
      return Response.json({ error: err.message }, { status: 415 });
    }
    const msg = err instanceof Error ? err.message : "Conversion failed.";
    const code = (err as Error & { code?: string }).code;
    const status = code === "CONVERT_FAILED" ? 502 : 500;
    return Response.json({ error: msg }, { status });
  }
}

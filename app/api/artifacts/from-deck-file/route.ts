import { NextRequest } from "next/server";
import path from "node:path";
import { getCurrentEmail } from "@/lib/session";
import { readDeckFile } from "@/lib/deck";
import { createSkill } from "@/lib/skills";
import {
  extractTextFromBuffer,
  UnsupportedFormatError,
} from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  /** Qualified deck path: "name" or "subdir/name". */
  deckPath?: string;
  /** Optional override; defaults to a humanised filename. */
  name?: string;
  /** Optional description for the new protocol. */
  description?: string;
}

function humaniseFilename(filename: string): string {
  const base = filename
    .split("/")
    .pop()!
    .replace(/\.[^./\\]+$/, "");
  return base
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(req: NextRequest) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const deckPath = (body?.deckPath ?? "").trim();
  if (!deckPath) {
    return Response.json(
      { error: "deckPath is required." },
      { status: 400 },
    );
  }

  // 1. Read the file from the user's deck.
  let buf: Buffer;
  try {
    const result = await readDeckFile(email, deckPath);
    buf = result.data;
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    const msg = err instanceof Error ? err.message : "Read failed.";
    const status =
      code === "NOT_FOUND" ? 404 : code === "BAD_NAME" || code === "PATH_ESCAPE" ? 400 : 500;
    return Response.json({ error: msg }, { status });
  }

  // 2. Extract markdown/plaintext from the file.
  let text: string;
  try {
    const out = await extractTextFromBuffer(buf, deckPath);
    text = out.text;
  } catch (err) {
    if (err instanceof UnsupportedFormatError) {
      return Response.json({ error: err.message }, { status: 415 });
    }
    const code = (err as Error & { code?: string }).code;
    const msg = err instanceof Error ? err.message : "Conversion failed.";
    const status = code === "CONVERT_FAILED" ? 502 : 500;
    return Response.json({ error: msg }, { status });
  }

  // 3. Create the new protocol artifact in the user's private skills folder.
  const filenameOnly = path.basename(deckPath);
  const protocolName = (body?.name ?? "").trim() || humaniseFilename(filenameOnly);
  const description =
    (body?.description ?? "").trim() ||
    `Imported from working-directory file ${filenameOnly}.`;
  if (!protocolName) {
    return Response.json(
      { error: "Could not derive a protocol name from the filename." },
      { status: 400 },
    );
  }

  try {
    const skill = createSkill(
      {
        name: protocolName,
        description,
        allowedTools: [],
        body: text,
        kind: "protocol",
      },
      email,
    );
    return Response.json({ skill }, { status: 201 });
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    const msg = err instanceof Error ? err.message : "Could not save protocol.";
    const status =
      code === "CONFLICT"
        ? 409
        : code === "INVALID"
          ? 400
          : code === "NO_ROOT"
            ? 500
            : 500;
    return Response.json({ error: msg }, { status });
  }
}

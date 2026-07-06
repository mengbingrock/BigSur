// Shared text-extraction helpers for the working-directory file → markdown
// conversion. Used by /api/artifacts/extract-text (file upload import) and
// /api/artifacts/from-deck-file (save existing deck file as protocol).

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
]);
export const SOFFICE_EXTENSIONS = new Set([".doc", ".odt", ".rtf"]);

export class UnsupportedFormatError extends Error {
  code = "UNSUPPORTED" as const;
  constructor(ext: string) {
    super(
      `Unsupported file type "${ext || "(none)"}". Try .md, .txt, .pdf, .docx, .doc, .odt, or .rtf.`,
    );
  }
}

export class ConvertFailedError extends Error {
  code = "CONVERT_FAILED" as const;
  constructor(detail: string) {
    super(detail);
  }
}

async function extractPdf(buf: Buffer): Promise<string> {
  const mod = (await import("pdf-parse")) as unknown as {
    PDFParse: new (opts: { data: Buffer }) => {
      getText(): Promise<{ text: string }>;
    };
  };
  const parser = new mod.PDFParse({ data: buf });
  const out = await parser.getText();
  return out.text ?? "";
}

async function extractDocx(buf: Buffer): Promise<string> {
  const mod = (await import("mammoth")) as unknown as {
    convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const out = await mod.convertToMarkdown({ buffer: buf });
  return out.value ?? "";
}

function runLibreOffice(
  inputPath: string,
  outDir: string,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      "soffice",
      [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        "txt",
        "--outdir",
        outDir,
        inputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => resolve({ ok: false, stderr: err.message }));
    proc.on("close", (code) => resolve({ ok: code === 0, stderr }));
  });
}

async function extractViaSoffice(buf: Buffer, ext: string): Promise<string> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "monterey-extract-"));
  const inputPath = path.join(tmp, `input${ext}`);
  await fsp.writeFile(inputPath, buf);
  try {
    const { ok, stderr } = await runLibreOffice(inputPath, tmp);
    if (!ok) {
      throw new ConvertFailedError(
        `Could not convert ${ext} — this format needs LibreOffice (\`soffice\`) on the server. ` +
          `Convert to .pdf, .docx, .md, or .txt first. Detail: ${stderr.trim().slice(0, 200)}`,
      );
    }
    return await fsp.readFile(path.join(tmp, "input.txt"), "utf8");
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface ExtractResult {
  text: string;
  format: string;
}

/**
 * Extract markdown/plain-text content from a file buffer. Returns the
 * extracted text and a format tag. Throws `UnsupportedFormatError` for
 * unknown types or `ConvertFailedError` when the conversion step fails.
 */
export async function extractTextFromBuffer(
  buf: Buffer,
  filename: string,
): Promise<ExtractResult> {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return { text: buf.toString("utf8"), format: ext.slice(1) };
  }
  if (ext === ".pdf") {
    return { text: await extractPdf(buf), format: "pdf" };
  }
  if (ext === ".docx") {
    return { text: await extractDocx(buf), format: "docx" };
  }
  if (SOFFICE_EXTENSIONS.has(ext)) {
    return { text: await extractViaSoffice(buf, ext), format: ext.slice(1) };
  }
  throw new UnsupportedFormatError(ext);
}

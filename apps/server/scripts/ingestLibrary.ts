// Ingest a BioProCorpus-shaped JSON file into the shared library on the box.
//
//   bun run ingest-library -- --file Protocol-io.json --source protocol-io --license "CC BY 4.0"
//
//   --file     the corpus JSON (an array of records)
//   --source   short source name, prefixed onto every id: protocol-io, protocol-exchange
//   --license  the licence the operator asserts for every record in this file;
//              refused unless on the allow-list (--allow to extend: comma-separated)
//   --limit    stop after N records (for a trial run)
//   --embed    run the embedding pass afterwards (needs an OpenAI key in the env)
//   --dry-run  map and count, write nothing
//
// Runs against the server's own data directory (LABEE_DATA_DIR / LABEE_DB_PATH),
// so run it on the box, with the server's env, while the server is up or down —
// rows are written in transactions and the server reads them fresh.
import fs from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const file = arg("file");
const source = arg("source");
const license = arg("license");
if (!file || !source || !license) {
  console.error("usage: ingestLibrary --file <json> --source <name> --license <licence> [--allow a,b] [--limit N] [--embed] [--dry-run]");
  process.exit(2);
}

const { DEFAULT_ALLOWED_LICENSES, ingestRecords, licenseAllowed, mapBioProRecord } = await import("../src/services/library/ingest");
const allow = arg("allow") ? [...DEFAULT_ALLOWED_LICENSES, ...arg("allow")!.split(",").map((s) => s.trim())] : DEFAULT_ALLOWED_LICENSES;
if (!licenseAllowed(license, allow)) {
  console.error(`refusing: "${license}" is not an allowed licence (${allow.join(", ")}). A non-commercial or share-alike licence cannot go in the library.`);
  process.exit(3);
}

const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
if (!Array.isArray(raw)) {
  console.error("the file is not a JSON array of records");
  process.exit(2);
}
const limit = Number(arg("limit") ?? raw.length);
const records = raw.slice(0, limit).map((r) => mapBioProRecord(r as Parameters<typeof mapBioProRecord>[0], { source, license })).filter((r): r is NonNullable<typeof r> => r !== null);
console.log(`${file}: ${raw.length} records, ${records.length} with steps${limit < raw.length ? ` (first ${limit})` : ""}`);

if (flag("dry-run")) {
  for (const r of records.slice(0, 3)) console.log(`\n--- ${r.id}: ${r.title}\n${r.body.slice(0, 600)}`);
  process.exit(0);
}

const report = await ingestRecords(records, {
  allow,
  embed: flag("embed"),
  onProgress: (done, total) => {
    if (done % 100 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
  },
});
process.stdout.write("\n");
console.log(`inserted ${report.inserted}, updated ${report.updated}, unchanged ${report.unchanged}, skipped ${report.skipped}, embedded ${report.embedded}`);

#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const tracePath = process.argv[2];
const outputPath = process.argv[3];
const cutoff = process.argv[4] ?? "2026-07-01";
const allowedSearchTool = process.argv[5] ?? "mcp__literature__search";
if (!tracePath || !outputPath) {
  throw new Error("usage: node audit-cutoff-trace.mjs <trace.json> <audit.json> [cutoff]");
}

const events = JSON.parse(await readFile(tracePath, "utf8"));
const isCodexTrace = events.some((event) => event?.type === "thread.started");
const initEvent = events.find(
  (event) => event?.type === "system" && event?.subtype === "init",
);
const loadedSkills = isCodexTrace ? [] : Array.isArray(initEvent?.skills) ? initEvent.skills : null;
const loadedPlugins = isCodexTrace ? [] : Array.isArray(initEvent?.plugins) ? initEvent.plugins : null;
const slashCommands = isCodexTrace ? [] : Array.isArray(initEvent?.slash_commands) ? initEvent.slash_commands : null;
const noProtocolSkill =
  loadedSkills != null
  && loadedPlugins != null
  && slashCommands != null
  && loadedSkills.length === 0
  && loadedPlugins.length === 0
  && slashCommands.length === 0;
const resultText = [];
const toolNames = [];
for (const event of events) {
  const item = event?.item;
  if (event?.type === "item.completed" && item?.type === "mcp_tool_call") {
    toolNames.push(`mcp__${item.server}__${item.tool}`);
    const content = Array.isArray(item.result?.content) ? item.result.content : [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") resultText.push(block.text);
    }
  }
  const message = event?.message;
  if (!message || !Array.isArray(message.content)) continue;
  for (const block of message.content) {
    if (block?.type === "tool_use") toolNames.push(block.name);
    if (block?.type !== "tool_result") continue;
    const content = Array.isArray(block.content) ? block.content : [];
    for (const item of content) {
      if (item?.type === "text" && typeof item.text === "string") resultText.push(item.text);
    }
  }
}

const doiPattern = /`doi:(10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+)`/g;
const dois = new Set();
for (const text of resultText) {
  for (const match of text.matchAll(doiPattern)) dois.add(match[1].toLowerCase());
}

function dateFromMessage(message) {
  const parts = message?.["published-online"]?.["date-parts"]?.[0]
    ?? message?.["published-print"]?.["date-parts"]?.[0]
    ?? message?.published?.["date-parts"]?.[0]
    ?? message?.issued?.["date-parts"]?.[0];
  if (!Array.isArray(parts) || !parts[0]) return null;
  const [year, month, day] = parts;
  if (year === 2026 && month == null) return null;
  const paddedMonth = String(month ?? 12).padStart(2, "0");
  const paddedDay = String(day ?? 31).padStart(2, "0");
  return `${year}-${paddedMonth}-${paddedDay}`;
}

async function lookup(originalDoi) {
  const candidates = originalDoi.endsWith("-v")
    ? [originalDoi, originalDoi.slice(0, -2)]
    : [originalDoi];
  for (const doi of candidates) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
        headers: { "User-Agent": "protocol-agent-cutoff-audit/1.0 (mailto:labee-research@labee.online)" },
      });
      if (response.ok) {
        const data = await response.json();
        const publicationDate = dateFromMessage(data.message);
        return {
          doi: originalDoi,
          queriedDoi: doi,
          title: Array.isArray(data.message?.title) ? data.message.title[0] : null,
          publicationDate,
          status: publicationDate == null
            ? "unresolved"
            : publicationDate < cutoff ? "pass" : "violation",
        };
      }
      if (response.status === 404) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  return { doi: originalDoi, queriedDoi: null, title: null, publicationDate: null, status: "unresolved" };
}

const pending = [...dois];
const records = [];
const workers = Array.from({ length: 3 }, async () => {
  while (pending.length > 0) {
    const doi = pending.shift();
    records.push(await lookup(doi));
  }
});
await Promise.all(workers);
records.sort((a, b) => a.doi.localeCompare(b.doi));

const hiddenPatterns = [
  "s41596-026-01419-w",
  "three-dimensional tracking of dynamic structures in living cells",
  "focusfeedbackgui",
];
const serializedTrace = JSON.stringify(events).toLowerCase();
const hiddenMatches = hiddenPatterns.filter((pattern) => serializedTrace.includes(pattern));
const violations = records.filter((record) => record.status === "violation");
const unresolved = records.filter((record) => record.status === "unresolved");
const prohibitedTools = toolNames.filter((name) => name !== allowedSearchTool);

const audit = {
  cutoff,
  cutoffRule: "publicationDate < cutoff",
  tracePath,
  traceFormat: isCodexTrace ? "codex-jsonl" : "claude-stream-json",
  loadedSkills,
  loadedPlugins,
  slashCommands,
  noProtocolSkill,
  allowedSearchTool,
  toolCalls: toolNames.length,
  toolNames: [...new Set(toolNames)],
  prohibitedTools,
  uniqueReturnedDois: records.length,
  passedDateChecks: records.filter((record) => record.status === "pass").length,
  violations,
  unresolved,
  hiddenAnswerMatches: hiddenMatches,
  strictPass:
    prohibitedTools.length === 0
    && violations.length === 0
    && unresolved.length === 0
    && hiddenMatches.length === 0
    && noProtocolSkill,
  records,
};

await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  cutoff: audit.cutoff,
  cutoffRule: audit.cutoffRule,
  noProtocolSkill: audit.noProtocolSkill,
  toolCalls: audit.toolCalls,
  toolNames: audit.toolNames,
  uniqueReturnedDois: audit.uniqueReturnedDois,
  passedDateChecks: audit.passedDateChecks,
  violations: audit.violations.length,
  unresolved: audit.unresolved.length,
  hiddenAnswerMatches: audit.hiddenAnswerMatches,
  strictPass: audit.strictPass,
}, null, 2)}\n`);
if (!audit.strictPass) process.exit(1);

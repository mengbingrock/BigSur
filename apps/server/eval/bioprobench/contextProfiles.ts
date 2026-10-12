/** Evaluation-only reconstruction of BioProBench Appendix C.3 context policy.
 * The paper specifies lengths, overlap and k, but not splitter boundaries.
 * Use fixed Unicode-code-point windows; retain overlap and retrieval order.
 */
export const paperProfiles = {
  small: { chunkChars: 2000, overlapChars: 400, topK: 5 },
  large: { chunkChars: 5000, overlapChars: 1000, topK: 3 },
} as const;
export type PaperProfile = keyof typeof paperProfiles;
export function paperProfile(task: string): PaperProfile {
  if (task === "PQA" || task === "ERR") return "small";
  if (task === "ORD" || task === "GEN") return "large";
  throw new Error(`Unsupported BioProBench task: ${task}`);
}
export function canonicalProtocolText(record: { title: string; description: string; body: string }): string {
  return `${record.title}\n${record.description}\n${record.body}`;
}
export function paperChunks(text: string, profile: PaperProfile) {
  const { chunkChars, overlapChars } = paperProfiles[profile];
  const chars = Array.from(text);
  const chunks: { text: string; startChar: number; endChar: number }[] = [];
  for (let startChar = 0; startChar < chars.length; startChar += chunkChars - overlapChars) {
    const endChar = Math.min(startChar + chunkChars, chars.length);
    chunks.push({ text: chars.slice(startChar, endChar).join(""), startChar, endChar });
    if (endChar === chars.length) break;
  }
  return chunks;
}
export function selectPaperPassages<T>(ranked: readonly T[], task: string): T[] {
  return ranked.slice(0, paperProfiles[paperProfile(task)].topK);
}
/** Official visible fields only; reference answers never become search queries. */
export function taskQuery(task: string, sample: Record<string, any>): string {
  switch (task) {
    case "PQA": return sample.question;
    case "ORD": return `${sample.question} ${sample.wrong_steps.join(" ")}`;
    case "ERR": return `${sample.is_correct ? sample.corrected_text : sample.corrupted_text} ${JSON.stringify(sample.context)}`;
    case "GEN": return `${sample.instruction} ${sample.input}`;
    default: throw new Error(`Unsupported BioProBench task: ${task}`);
  }
}

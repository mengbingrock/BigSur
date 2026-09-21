#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) throw new Error("usage: node calculate-formula-score.mjs <result.json>");
const result = JSON.parse(await readFile(file, "utf8"));

const fidelityAtoms = result.components.fidelity.atoms;
const fidelityEarned = fidelityAtoms.reduce(
  (sum, atom) => sum + atom.weight * atom.credit,
  0,
);
const fidelityPossible = fidelityAtoms.reduce((sum, atom) => sum + atom.weight, 0);
const fidelity = fidelityEarned / fidelityPossible;

function meanChecks(component) {
  const values = Object.values(component.checks);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const procedureStructure = meanChecks(result.components.procedureStructure);
const provenance = meanChecks(result.components.provenance);
const usefulness = meanChecks(result.components.usefulness);
const quality =
  0.4 * fidelity +
  0.2 * procedureStructure +
  0.2 * provenance +
  0.2 * usefulness;
const score = result.hardPass ? quality : 0;

process.stdout.write(`${JSON.stringify({
  fidelity,
  procedureStructure,
  provenance,
  usefulness,
  quality,
  score,
  hardPass: result.hardPass,
  casePass: result.hardPass && quality >= result.passThreshold,
}, null, 2)}\n`);

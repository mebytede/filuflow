#!/usr/bin/env node
// Wandelt die Ausgabe von `n8n execute --rawOutput` (bzw. das Execution-JSON) in expected.json um.
// Aufruf: node scripts/extract-expected.mjs <rohausgabe.txt> <expected.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
const text = readFileSync(input, 'utf8');

/** Das erste JSON-Objekt, das in Spalte 0 mit "{" beginnt und mit "}" endet */
function extractJson(raw) {
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => l === '{');
  if (start === -1) throw new Error(`Kein JSON in ${input}:\n${raw.slice(0, 2000)}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return JSON.parse(lines.slice(start, end + 1).join('\n'));
}

const exec = extractJson(text);
const resultData = exec.data?.resultData ?? exec.resultData;
const runData = resultData.runData;

function cleanItem(item) {
  const out = { json: item.json };
  if (item.binary) {
    out.binary = {};
    for (const [k, v] of Object.entries(item.binary)) {
      const { data, id: _id, ...rest } = v;
      out.binary[k] = { ...rest, ...(data && data !== 'filesystem' && data !== 'filesystem-v2' ? { data } : {}) };
    }
  }
  if (item.pairedItem !== undefined) out.pairedItem = item.pairedItem;
  if (item.error !== undefined) out.error = { message: item.error.message };
  return out;
}

const nodes = {};
for (const [name, runs] of Object.entries(runData)) {
  nodes[name] = runs.map((run) => {
    const r = {
      status: run.executionStatus,
      source: run.source ?? [],
      main: (run.data?.main ?? []).map((output) => (output === null ? null : output.map(cleanItem))),
    };
    if (run.error) r.error = run.error.message;
    return r;
  });
}

const expected = {
  status: resultData.error ? 'error' : 'success',
  lastNodeExecuted: resultData.lastNodeExecuted,
  ...(resultData.error ? { error: resultData.error.message } : {}),
  // Reihenfolge der Ausführung (executionIndex)
  order: Object.entries(runData)
    .flatMap(([name, runs]) => runs.map((r) => ({ name, i: r.executionIndex })))
    .sort((a, b) => a.i - b.i)
    .map((e) => e.name),
  nodes,
};
writeFileSync(output, `${JSON.stringify(expected, null, 2)}\n`);
console.log(`geschrieben: ${output}`);

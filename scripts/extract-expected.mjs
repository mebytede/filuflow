#!/usr/bin/env node
// Wandelt die Ausgabe von `n8n execute --rawOutput` (bzw. das Execution-JSON) in expected.json um.
// Aufruf: node scripts/extract-expected.mjs <rohausgabe.txt> <expected.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resultDataToSnapshot } from './snapshot-lib.mjs';

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
writeFileSync(output, `${JSON.stringify(resultDataToSnapshot(resultData), null, 2)}\n`);
console.log(`geschrieben: ${output}`);

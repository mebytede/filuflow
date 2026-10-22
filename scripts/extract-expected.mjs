#!/usr/bin/env node
// Converts the output of `n8n execute --rawOutput` (or the execution JSON) into expected.json.
// Usage: node scripts/extract-expected.mjs <raw-output.txt> <expected.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resultDataToSnapshot } from './snapshot-lib.mjs';

const [, , input, output] = process.argv;
const text = readFileSync(input, 'utf8');

/** The first JSON object that starts with "{" and ends with "}" in column 0 */
function extractJson(raw) {
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => l === '{');
  if (start === -1) throw new Error(`No JSON in ${input}:\n${raw.slice(0, 2000)}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return JSON.parse(lines.slice(start, end + 1).join('\n'));
}

const exec = extractJson(text);
const resultData = exec.data?.resultData ?? exec.resultData;
writeFileSync(output, `${JSON.stringify(resultDataToSnapshot(resultData), null, 2)}\n`);
console.log(`written: ${output}`);

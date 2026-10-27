#!/usr/bin/env node
// Reads the executions from the SQLite database of the reference implementation and writes expected.json for webhook fixtures:
// { "responses": [...], "executions": [ <snapshot per execution, sorted by ID> ] }
// Usage: node scripts/extract-webhook.mjs <database.sqlite> <responses.json> <expected.json>
import { readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { flattedParse, resultDataToSnapshot } from './snapshot-lib.mjs';

const [, , dbFile, responsesFile, output] = process.argv;
const db = new Database(dbFile, { readonly: true });
const rows = db
  .prepare('SELECT e.id, e.mode, e.status, d.data FROM execution_entity e JOIN execution_data d ON d.executionId = e.id ORDER BY e.id')
  .all();
const executions = rows.map((row) => {
  const data = flattedParse(row.data);
  return { mode: row.mode, ...resultDataToSnapshot(data.resultData) };
});
const responses = JSON.parse(readFileSync(responsesFile, 'utf8'));
writeFileSync(output, `${JSON.stringify({ responses, executions }, null, 2)}\n`);
console.log(`written: ${output} (${executions.length} executions)`);

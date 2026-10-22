#!/usr/bin/env node
// Converts fixtures/<name>/credentials.json (filuflow format { "<Name>": { id, type, data } })
// into the import format of `n8n import:credentials` (array with id, name, type, data unencrypted).
// Usage: node scripts/credentials-to-n8n.mjs <credentials.json> <output.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
const raw = JSON.parse(readFileSync(input, 'utf8'));
const list = Object.entries(raw).map(([name, c]) => {
  if (!c.id || !c.type || !c.data) throw new Error(`Credential "${name}" needs id, type and data`);
  return { id: c.id, name, type: c.type, data: c.data };
});
writeFileSync(output, JSON.stringify(list));

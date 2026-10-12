#!/usr/bin/env node
// Wandelt fixtures/<name>/credentials.json (filuflow-Format { "<Name>": { id, type, data } })
// in das Importformat von `n8n import:credentials` (Array mit id, name, type, data unverschlüsselt).
// Aufruf: node scripts/credentials-to-n8n.mjs <credentials.json> <ausgabe.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
const raw = JSON.parse(readFileSync(input, 'utf8'));
const list = Object.entries(raw).map(([name, c]) => {
  if (!c.id || !c.type || !c.data) throw new Error(`Credential "${name}" braucht id, type und data`);
  return { id: c.id, name, type: c.type, data: c.data };
});
writeFileSync(output, JSON.stringify(list));

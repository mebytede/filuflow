#!/usr/bin/env bash
# Erzeugt test/oracle/expression-table.json.gz: Ergebnisse von n8n Expression.getParameterValue
# (n8n-workflow aus dem gepinnten Image) für alle Fälle aus scripts/oracle-cases.mjs (extensionCases).
set -euo pipefail
N8N_IMAGE="${N8N_IMAGE:-n8nio/n8n:1.123.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; chmod 777 "$WORK"; trap 'rm -rf "$WORK"' EXIT
node --input-type=module -e "
import { extensionCases, EXPRESSION_DATA } from '$ROOT/scripts/oracle-cases.mjs';
import { writeFileSync } from 'node:fs';
writeFileSync('$WORK/cases.json', JSON.stringify({ cases: extensionCases(), data: EXPRESSION_DATA }));
"
cat > "$WORK/run.cjs" <<'JS'
const fs = require('fs');
const { Workflow } = require('/usr/local/lib/node_modules/n8n/node_modules/n8n-workflow');
const { DateTime } = require('/usr/local/lib/node_modules/n8n/node_modules/luxon');
const { cases, data } = JSON.parse(fs.readFileSync('/data/cases.json', 'utf8'));
const nodeTypes = {
  getByNameAndVersion: () => ({ description: { properties: [], inputs: ['main'], outputs: ['main'] } }),
  getByName: () => ({ description: { properties: [] } }),
  getKnownTypes: () => ({}),
};
const wf = new Workflow({
  id: 'wf1', name: 'wf', active: false, nodeTypes, connections: {},
  nodes: [{ id: '1', name: 'N', type: 'x.y', typeVersion: 1, position: [0, 0], parameters: {} }],
  settings: { timezone: 'Europe/Berlin' },
});
function encode(v) {
  if (v === undefined) return { __undef: true };
  if (typeof v === 'number' && Number.isNaN(v)) return { __nan: true };
  if (DateTime.isDateTime(v)) return { __dt: v.toISO(), zone: v.zoneName };
  if (Object.prototype.toString.call(v) === '[object Date]') return { __date: isNaN(v) ? 'invalid' : v.toISOString() };
  if (typeof v === 'function') return { __fn: true };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
const out = cases.map((tpl) => {
  try {
    const v = wf.expression.getParameterValue('=' + tpl, null, 0, 0, 'N', [{ json: JSON.parse(JSON.stringify(data)) }], 'manual', {});
    return { result: encode(v) };
  } catch (e) {
    return { error: e.message };
  }
});
fs.writeFileSync('/data/results.json', JSON.stringify(out));
JS
docker run --rm -v "$WORK:/data" -e TZ=Europe/Berlin -e GENERIC_TIMEZONE=Europe/Berlin --entrypoint node "$N8N_IMAGE" /data/run.cjs
mkdir -p "$ROOT/test/oracle"
node -e "
const fs=require('fs');
const { cases, data } = JSON.parse(fs.readFileSync('$WORK/cases.json','utf8'));
const results=JSON.parse(fs.readFileSync('$WORK/results.json','utf8'));
fs.writeFileSync('$ROOT/test/oracle/expression-table.json.gz', require('zlib').gzipSync(JSON.stringify({ data, cases: cases.map((c,i)=>({ tpl: c, expected: results[i] })) }), { level: 9 }));
console.log('Fälle:', cases.length);
"

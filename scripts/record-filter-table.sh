#!/usr/bin/env bash
# Generates test/oracle/filter-table.json: results of executeFilterCondition of the reference (n8n-workflow from the
# pinned reference image) for all cases from scripts/oracle-cases.mjs.
set -euo pipefail
REFERENCE_IMAGE="${REFERENCE_IMAGE:-n8nio/n8n:1.123.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; chmod 777 "$WORK"; trap 'rm -rf "$WORK"' EXIT
node --input-type=module -e "
import { filterCases } from '$ROOT/scripts/oracle-cases.mjs';
import { writeFileSync } from 'node:fs';
// undefined does not survive JSON: encode it as a marker
const enc = (v) => (v === undefined ? { __undef: true } : v);
writeFileSync('$WORK/cases.json', JSON.stringify(filterCases().map((c) => ({ ...c, condition: { ...c.condition, leftValue: enc(c.condition.leftValue), rightValue: enc(c.condition.rightValue) } }))));
"
cat > "$WORK/run.cjs" <<'JS'
const fs = require('fs');
const { executeFilterCondition } = require('/usr/local/lib/node_modules/n8n/node_modules/n8n-workflow');
const dec = (v) => (v && typeof v === 'object' && v.__undef ? undefined : v);
const cases = JSON.parse(fs.readFileSync('/data/cases.json', 'utf8'));
const out = cases.map((c) => {
  const condition = { ...c.condition, leftValue: dec(c.condition.leftValue), rightValue: dec(c.condition.rightValue) };
  try { return { result: executeFilterCondition(condition, c.options, { index: 0, itemIndex: 0 }) }; }
  catch (e) { return { error: e.message }; }
});
fs.writeFileSync('/data/results.json', JSON.stringify(out));
JS
docker run --rm -v "$WORK:/data" -e TZ=Europe/Berlin -e GENERIC_TIMEZONE=Europe/Berlin --entrypoint node "$REFERENCE_IMAGE" /data/run.cjs
mkdir -p "$ROOT/test/oracle"
node -e "
const fs=require('fs');
const cases=JSON.parse(fs.readFileSync('$WORK/cases.json','utf8'));
const results=JSON.parse(fs.readFileSync('$WORK/results.json','utf8'));
fs.writeFileSync('$ROOT/test/oracle/filter-table.json.gz', require('zlib').gzipSync(JSON.stringify(cases.map((c,i)=>({...c, expected: results[i]}))), { level: 9 }));
console.log('Cases:', cases.length);
"

#!/usr/bin/env bash
# Oracle for the AI tools: runs reference code in the container and stores the results in test/oracle/ai-tools.json
#   - Calculator tool (@langchain/community Calculator with math-expression-evaluator)
#   - $fromAI placeholders (n8n-workflow extractFromAICalls) and the JSON schema generated from them
#     (generateZodSchema, z.object(...).required(), zod-to-json-schema as in the tools)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REFERENCE_IMAGE="${REFERENCE_IMAGE:-n8nio/n8n:1.123.0}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/filuflow-ai-tools.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
node -e '
  import("'"$ROOT"'/scripts/ai-tools-oracle-cases.mjs").then((m) => {
    require("fs").writeFileSync(process.argv[1], JSON.stringify({ calculator: m.CALCULATOR, fromAI: m.FROM_AI }));
  });
' "$WORK/cases.json"
cat > "$WORK/run.mjs" <<'JS'
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/usr/local/lib/node_modules/n8n/node_modules/@n8n/n8n-nodes-langchain/dist/index.js');
const { Calculator } = await import(require.resolve('@langchain/community/tools/calculator'));
const { extractFromAICalls, generateZodSchema } = require('n8n-workflow');
const { z } = require('zod');
const { toJsonSchema } = await import(require.resolve('@langchain/core/utils/json_schema'));
const cases = JSON.parse(fs.readFileSync('/data/cases.json', 'utf8'));
const calc = new Calculator();
const out = { calculator: [], fromAI: [] };
for (const input of cases.calculator) out.calculator.push({ input, output: await calc.invoke(input) });
for (const text of cases.fromAI) {
  try {
    const args = extractFromAICalls(text);
    const unique = new Map();
    for (const a of args) unique.set(a.key, a);
    const shape = {};
    for (const a of unique.values()) shape[a.key] = generateZodSchema(a);
    let schema;
    try { schema = toJsonSchema(z.object(shape).required()); } catch (e) { schema = { error: e.message }; }
    out.fromAI.push({ text, args, schema });
  } catch (e) {
    out.fromAI.push({ text, error: e.message });
  }
}
fs.writeFileSync('/data/out.json', JSON.stringify(out, null, 1));
JS
chmod -R 777 "$WORK"
docker run --rm -v "$WORK:/data" --entrypoint node "$REFERENCE_IMAGE" /data/run.mjs
cp "$WORK/out.json" "$ROOT/test/oracle/ai-tools.json"
echo "written: test/oracle/ai-tools.json"

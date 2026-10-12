#!/usr/bin/env bash
# Orakel für KI-Hilfsfunktionen: führt n8n-Code (n8n-nodes-langchain) im Container aus und speichert
# die Ergebnisse in test/oracle/ai-table.json.gz (Schema aus Beispiel, Format-Anweisungen, Parser-Ergebnisse).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N8N_IMAGE="${N8N_IMAGE:-n8nio/n8n:1.123.0}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/flowlite-ai-oracle.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
node -e '
  import("'"$ROOT"'/scripts/ai-oracle-cases.mjs").then((m) => {
    require("fs").writeFileSync(process.argv[1], JSON.stringify({ examples: m.EXAMPLES, schemas: m.SCHEMAS, texts: m.TEXTS }));
  });
' "$WORK/cases.json"
cat > "$WORK/run.js" <<'JS'
const fs = require('fs');
const base = '/usr/local/lib/node_modules/n8n/node_modules/@n8n/n8n-nodes-langchain/dist';
const { generateSchemaFromExample, convertJsonSchemaToZod } = require(base + '/utils/schemaParsing.js');
const { N8nStructuredOutputParser } = require(base + '/utils/output_parsers/N8nStructuredOutputParser.js');
const cases = JSON.parse(fs.readFileSync('/data/cases.json', 'utf8'));
const ctx = {
  addInputData: () => ({ index: 0 }),
  addOutputData: () => undefined,
  getNode: () => ({ name: 'Parser', type: 'x', typeVersion: 1 }),
  logAiEvent: () => undefined,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  getExecutionId: () => '1',
  getWorkflow: () => ({ id: '1' }),
};
const err = (e) => ({ error: e.message, reason: e.context?.outputParserFailReason });
(async () => {
  const out = { examples: [], parsers: [] };
  for (const ex of cases.examples) {
    for (const req of [false, true]) {
      try {
        out.examples.push({ example: ex, allRequired: req, schema: generateSchemaFromExample(ex, req) });
      } catch (e) { out.examples.push({ example: ex, allRequired: req, error: e.message }); }
    }
  }
  const schemas = [
    ...cases.examples.map((ex) => ({ source: 'example', example: ex, schema: generateSchemaFromExample(ex, true) })),
    ...cases.examples.map((ex) => ({ source: 'example12', example: ex, schema: generateSchemaFromExample(ex, false) })),
    ...cases.schemas.map((s) => ({ source: 'manual', schema: s })),
  ];
  for (const s of schemas) {
    for (const version of [1, 1.2, 1.3]) {
      const entry = { schema: s.schema, version, source: s.source };
      try {
        const zod = convertJsonSchemaToZod(s.schema);
        const parser = await N8nStructuredOutputParser.fromZodJsonSchema(zod, version, ctx);
        entry.instructions = parser.getFormatInstructions();
        entry.results = [];
        for (const text of cases.texts) {
          try { entry.results.push({ text, value: await parser.parse(text) }); }
          catch (e) { entry.results.push({ text, ...err(e) }); }
        }
      } catch (e) { entry.error = e.message; }
      out.parsers.push(entry);
    }
  }
  fs.writeFileSync('/data/out.json', JSON.stringify(out));
})();
JS
chmod -R 777 "$WORK"
docker run --rm -v "$WORK:/data" --entrypoint node "$N8N_IMAGE" /data/run.js
gzip -c "$WORK/out.json" > "$ROOT/test/oracle/ai-table.json.gz"
echo "geschrieben: test/oracle/ai-table.json.gz"

// KI-Hilfsfunktionen gegen n8n-Code als Orakel (test/oracle/ai-table.json.gz, scripts/record-ai-oracle.sh):
// Schema aus Beispiel-JSON, Format-Anweisungen und Parser-Ergebnisse des Structured Output Parsers.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { generateSchemaFromExample } from '../src/ai/schema.js';
import { StructuredOutputParser } from '../src/ai/outputParser.js';
import type { NodeOperationError } from '../src/errors.js';

interface Table {
  examples: Array<{ example: string; allRequired: boolean; schema?: unknown; error?: string }>;
  parsers: Array<{
    schema: Record<string, unknown>;
    version: number;
    source: string;
    instructions?: string;
    error?: string;
    results?: Array<{ text: string; value?: unknown; error?: string; reason?: string }>;
  }>;
}

const table = JSON.parse(gunzipSync(readFileSync(join(__dirname, 'oracle', 'ai-table.json.gz'))).toString('utf8')) as Table;

describe('KI-Orakel', () => {
  it('erzeugt Schemas aus Beispielen wie generate-schema', () => {
    for (const c of table.examples) {
      expect({ example: c.example, req: c.allRequired, schema: generateSchemaFromExample(c.example, c.allRequired) }).toEqual({
        example: c.example,
        req: c.allRequired,
        schema: c.schema,
      });
    }
  });

  it('erzeugt dieselben Format-Anweisungen und Parser-Ergebnisse', () => {
    let count = 0;
    for (const p of table.parsers) {
      if (p.error) continue;
      const parser = new StructuredOutputParser('Parser', structuredClone(p.schema), p.version);
      expect({ v: p.version, schema: p.schema, instructions: parser.getFormatInstructions() }).toEqual({
        v: p.version,
        schema: p.schema,
        instructions: p.instructions,
      });
      for (const r of p.results ?? []) {
        let actual: Record<string, unknown>;
        try {
          actual = { value: parser.parse(r.text) };
        } catch (e) {
          const err = e as NodeOperationError;
          actual = { error: err.message, reason: err.extra?.outputParserFailReason };
        }
        const expected = r.error !== undefined ? { error: r.error, reason: r.reason } : { value: r.value };
        expect({ v: p.version, schema: p.schema, text: r.text, ...actual }).toEqual({ v: p.version, schema: p.schema, text: r.text, ...expected });
        count++;
      }
    }
    expect(count).toBeGreaterThan(1000);
  });
});

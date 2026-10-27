// AI tools against reference code as an oracle (test/oracle/ai-tools.json, scripts/record-ai-tools-oracle.sh):
// Calculator tool and $fromAI placeholders with the JSON Schema generated from them.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculate } from '../src/ai/calculator.js';
import { extractFromAICalls, extractFromAIParameters, schemaFromArguments, type FromAIArgument } from '../src/ai/fromAI.js';
import { zodToJsonSchema } from '../src/ai/schema.js';

interface Table {
  calculator: Array<{ input: string; output: string }>;
  fromAI: Array<{ text: string; args?: FromAIArgument[]; schema?: unknown; error?: string }>;
}

const table = JSON.parse(readFileSync(join(__dirname, 'oracle', 'ai-tools.json'), 'utf8')) as Table;

describe('Calculator like the reference', () => {
  for (const c of table.calculator) {
    it(JSON.stringify(c.input), () => {
      expect(calculate(c.input)).toBe(c.output);
    });
  }
});

describe('$fromAI like the reference', () => {
  for (const c of table.fromAI) {
    it(c.text, () => {
      if (c.error) {
        expect(() => extractFromAICalls(c.text)).toThrow(c.error);
        return;
      }
      const args = extractFromAICalls(c.text);
      expect(JSON.parse(JSON.stringify(args))).toEqual(c.args);
      expect(zodToJsonSchema(schemaFromArguments(extractFromAIParameters(c.text)))).toEqual(c.schema);
    });
  }
});

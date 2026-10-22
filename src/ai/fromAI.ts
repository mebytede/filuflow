// Find $fromAI placeholders in node parameters and build the argument schema of a tool from them.
// Rebuilt after n8n 1.123.0 packages/workflow/src/from-ai-parse-utils.ts
// (extractFromAICalls, parseArguments, parseDefaultValue, generateZodSchema, traverseNodeParameters)
// and packages/@n8n/nodes-langchain/utils/fromAIToolFactory.ts (extractFromAIParameters, createZodSchemaFromArgs).
import type { ZType } from './schema.js';

export type FromAIArgumentType = 'string' | 'number' | 'boolean' | 'json';

export interface FromAIArgument {
  key: string;
  description?: string;
  type?: FromAIArgumentType;
  defaultValue?: string | number | boolean | Record<string, unknown>;
}

export class FromAIParseError extends Error {}

function isFromAIArgumentType(value: string): value is FromAIArgumentType {
  return ['string', 'number', 'boolean', 'json'].includes(value.toLowerCase());
}

function parseDefaultValue(value: string | undefined, type: FromAIArgumentType = 'string'): FromAIArgument['defaultValue'] {
  if (value === undefined) return value;
  const lower = value.toLowerCase();
  if (type === 'string') return value.toString();
  if (type === 'boolean' && (lower === 'true' || lower === 'false')) return lower === 'true';
  if (type === 'number' && !isNaN(Number(value))) return Number(value);
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return value;
  }
}

function parseArguments(argsString: string): FromAIArgument {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let escapeNext = false;
  for (const char of argsString) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (['"', "'", '`'].includes(char)) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      }
      current += char;
      continue;
    }
    if (char === ',' && !inQuotes) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current) args.push(current.trim());
  const clean = args.map((arg) => {
    const t = arg.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('`') && t.endsWith('`')) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1).replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return t;
  });
  const type = clean[2] ?? 'string';
  if (!isFromAIArgumentType(type)) throw new FromAIParseError(`Invalid type: ${type}`);
  return { key: clean[0] || '', description: clean[1], type, defaultValue: parseDefaultValue(clean[3], type) };
}

/** All $fromAI calls in a text */
export function extractFromAICalls(str: string): FromAIArgument[] {
  const out: FromAIArgument[] = [];
  const pattern = /\$fromAI\s*\(\s*/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(str)) !== null) {
    const startIndex = match.index + match[0].length;
    let current = startIndex;
    let inQuotes = false;
    let quoteChar = '';
    let depth = 1;
    let argsString = '';
    while (current < str.length && depth > 0) {
      const char = str[current];
      if (inQuotes) {
        if (char === '\\' && current + 1 < str.length) {
          argsString += char + str[current + 1];
          current += 2;
          continue;
        }
        if (char === quoteChar) {
          inQuotes = false;
          quoteChar = '';
        }
        argsString += char;
      } else {
        if (['"', "'", '`'].includes(char)) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === '(') depth++;
        else if (char === ')') depth--;
        if (depth > 0 || char !== ')') argsString += char;
      }
      current++;
    }
    if (depth !== 0) throw new FromAIParseError(`Unbalanced parentheses while parsing $fromAI call: ${str.slice(startIndex)}`);
    try {
      out.push(parseArguments(argsString));
    } catch (error) {
      throw new FromAIParseError(`Failed to parse $fromAI arguments: ${argsString}: ${String(error)}`);
    }
  }
  return out;
}

export function traverseNodeParameters(payload: unknown, collected: FromAIArgument[]): void {
  if (typeof payload === 'string') collected.push(...extractFromAICalls(payload));
  else if (Array.isArray(payload)) payload.forEach((p) => traverseNodeParameters(p, collected));
  else if (typeof payload === 'object' && payload !== null) Object.values(payload).forEach((v) => traverseNodeParameters(v, collected));
}

/** Unique arguments (same key: the last definition wins, at the position of the first) */
export function extractFromAIParameters(parameters: unknown): FromAIArgument[] {
  const collected: FromAIArgument[] = [];
  traverseNodeParameters(parameters, collected);
  const unique = new Map<string, FromAIArgument>();
  for (const arg of collected) unique.set(arg.key, arg);
  return [...unique.values()];
}

/** generateZodSchema */
function argumentSchema(arg: FromAIArgument): ZType {
  let schema: ZType;
  switch (arg.type?.toLowerCase()) {
    case 'number':
      schema = { kind: 'number', checks: [] };
      break;
    case 'boolean':
      schema = { kind: 'boolean' };
      break;
    case 'json':
      // z.custom: non-empty object or array
      schema = {
        kind: 'refine',
        inner: { kind: 'any' },
        check: (v) => v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0),
        message: 'Value must be a non-empty object or a non-empty array',
        path: [],
      };
      break;
    default:
      schema = { kind: 'string', checks: [] };
  }
  if (arg.description) schema.description = arg.description.trim();
  if (arg.defaultValue !== undefined) {
    schema = { kind: 'default', inner: schema, value: arg.defaultValue, ...(schema.description ? { description: schema.description } : {}) };
  }
  return schema;
}

/** createZodSchemaFromArgs: z.object(...).required() */
export function schemaFromArguments(args: FromAIArgument[]): ZType {
  const shape: Record<string, ZType> = {};
  for (const arg of args) shape[arg.key] = argumentSchema(arg);
  return { kind: 'object', shape, unknownKeys: 'strip' };
}

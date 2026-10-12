// Umwandlung von Tool-Schemas in die Formate der Anbieter.
// Gemini: @langchain/google-genai utils/zod_to_genai_parameters.js (removeAdditionalProperties, ohne $schema).
import type { JsonSchema } from '../schema.js';

function removeAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeAdditionalProperties);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete out.additionalProperties;
  delete out.$schema;
  delete out.strict;
  for (const key of Object.keys(out)) out[key] = removeAdditionalProperties(out[key]);
  return out;
}

export function toGeminiParameters(schema: JsonSchema): JsonSchema {
  return removeAdditionalProperties(schema) as JsonSchema;
}

/** Tool ohne Parameter: Gemini bekommt kein "parameters"-Feld */
export function hasNoParameters(schema: JsonSchema): boolean {
  return schema.type === 'object' && typeof schema.properties === 'object' && Object.keys(schema.properties as object).length === 0;
}

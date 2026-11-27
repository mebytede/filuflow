// Values of resource mapper parameters (M52): getParam("<name>.value") checks and converts every value against the stored
// schema of the parameter. Reference: n8n-core 1.122.0 (reference version 1.123.0),
// dist/execution-engine/node-execution-context/utils/validate-value-against-schema.js (validateResourceMapperValue).
// Own implementation.
import { ExpressionError } from '../errors.js';
import type { ParamSchema } from '../nodes/params.js';
import { validateFieldType } from '../nodes/shared/utils.js';
import { findParamSchema } from './extractValue.js';

type Values = Record<string, unknown>;

interface StoredField {
  id: string;
  type?: string;
  required?: boolean;
  options?: Array<{ value: unknown }>;
}

const isObject = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Converted values of "<resourceMapper>.value" (the object is changed in place like the reference); other paths and
 * values are returned as they are. Throws ExpressionError "Invalid input for '<field>' [item i]".
 */
export function validateResourceMapperValue(
  path: string,
  value: unknown,
  schema: ParamSchema[] | undefined,
  node: { name: string; typeVersion: number; parameters?: Values },
  itemIndex: number,
): unknown {
  const parts = path.split('.');
  if (parts.length !== 2 || parts[1] !== 'value' || !isObject(value)) return value;
  const def = findParamSchema(schema, parts[0], node.parameters ?? {}, node.typeVersion);
  if (def?.type !== 'resourceMapper') return value;
  const stored = (node.parameters ?? {})[parts[0]];
  if (!isObject(stored) || !Array.isArray(stored.schema)) return value;
  const options = def.resourceMapper;
  const skipRequiredCheck = options?.mode !== 'add';
  const typeOptions = options?.showTypeConversionOptions === true;
  const fields = stored.schema as StoredField[];
  for (const key of Object.keys(value)) {
    const entry = fields.find((f) => f.id === key);
    const fail = (description: string) => new ExpressionError(`Invalid input for '${key}' [item ${itemIndex}]`, { description, itemIndex, nodeName: node.name });
    if (!skipRequiredCheck && entry?.required === true && entry.type !== 'boolean' && (value[key] === undefined || value[key] === null)) {
      throw fail(`The value "${key}" is required but not set`);
    }
    if (!entry?.type) continue;
    const result = validateFieldType(key, value[key], entry.type, {
      valueOptions: entry.options,
      strict: typeOptions && stored.attemptToConvertTypes !== true,
      parseStrings: typeOptions && stored.convertFieldsToString === true,
    });
    if (!result.valid) throw fail(result.errorMessage);
    value[key] = result.newValue;
  }
  return value;
}

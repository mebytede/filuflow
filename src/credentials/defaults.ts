// Defaults of a credential on load (M28), as in the reference version 1.123.0 CredentialsHelper.applyDefaultsAndOverwrites
// (packages/cli/src/credentials-helper.ts): NodeHelpers.getNodeParameters fills missing values of visible fields
// (including inherited and hidden ones) with their default, then expressions with $self (the values of the credential)
// are evaluated. filuflow evaluates expressions only in hidden fields: they come from the type description or from
// an exported file; entered values (e.g. a password that starts with "=") stay unchanged.
import vm from 'node:vm';
import { credentialType, isFieldVisible } from './types.js';

const EXPRESSION_TIMEOUT_MS = 1000;

/** Evaluate "={{ ... }}" or "=Text{{ ... }}Text" with $self; a single expression keeps its type */
export function resolveCredentialExpression(value: unknown, self: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const template = value.slice(1);
  // Type descriptions and credentials come from operators (trusted); vm with a time limit as for expressions
  const context = vm.createContext({ $self: self });
  const evaluate = (code: string): unknown => vm.runInContext(`(${code})`, context, { timeout: EXPRESSION_TIMEOUT_MS });
  const whole = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(template);
  if (whole && !whole[1].includes('}}')) return evaluate(whole[1]);
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, code: string) => {
    const v = evaluate(code);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Fill missing values with the defaults of the type, evaluate expressions of hidden fields */
export function applySchemaDefaults(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const schema = credentialType(type);
  if (!schema) return data;
  const out = { ...data };
  // First the own values, then defaults in field order (visibility depends on earlier values)
  for (const field of schema.fields) {
    if (out[field.name] !== undefined || field.default === undefined) continue;
    if (isFieldVisible(schema, field, out)) out[field.name] = field.default;
  }
  const self = { ...out };
  for (const field of schema.fields) {
    if (field.kind === 'hidden' && typeof out[field.name] === 'string') out[field.name] = resolveCredentialExpression(out[field.name], self);
  }
  return out;
}

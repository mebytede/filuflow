// Defaults eines Credentials beim Laden (M28), wie n8n 1.123.0 CredentialsHelper.applyDefaultsAndOverwrites
// (packages/cli/src/credentials-helper.ts): NodeHelpers.getNodeParameters ergänzt fehlende Werte sichtbarer Felder
// (auch geerbter und versteckter) mit ihrem Default, danach werden Ausdrücke mit $self (den Werten des Credentials)
// ausgewertet. filuflow wertet Ausdrücke nur in versteckten Feldern aus: sie kommen aus der Typbeschreibung oder aus
// einem n8n-Export, eingegebene Werte (z. B. ein Passwort, das mit "=" beginnt) bleiben unverändert.
import vm from 'node:vm';
import { credentialType, isFieldVisible } from './types.js';

const EXPRESSION_TIMEOUT_MS = 1000;

/** "={{ … }}" bzw. "=Text{{ … }}Text" mit $self auswerten; ein einzelner Ausdruck behält seinen Typ */
export function resolveCredentialExpression(value: unknown, self: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const template = value.slice(1);
  // Typbeschreibungen und Credentials stammen von Betreibern (vertrauenswürdig); vm mit Zeitlimit wie bei Expressions
  const context = vm.createContext({ $self: self });
  const evaluate = (code: string): unknown => vm.runInContext(`(${code})`, context, { timeout: EXPRESSION_TIMEOUT_MS });
  const whole = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(template);
  if (whole && !whole[1].includes('}}')) return evaluate(whole[1]);
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, code: string) => {
    const v = evaluate(code);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Fehlende Werte mit den Defaults des Typs ergänzen, Ausdrücke versteckter Felder auswerten */
export function applySchemaDefaults(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const schema = credentialType(type);
  if (!schema) return data;
  const out = { ...data };
  // Erst die eigenen Werte, dann Defaults in der Reihenfolge der Felder (Sichtbarkeit hängt von früheren Werten ab)
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

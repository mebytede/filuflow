// Splits an expression into text and code parts ({{ ... }}).
// Behavior like @n8n/tournament 1.0.6 (ExpressionSplitter): `\{{` is escaped,
// in text parts `\\` becomes `\`, in code parts `\}}` becomes `}}` (first occurrence only).

export interface TextChunk {
  type: 'text';
  text: string;
}
export interface CodeChunk {
  type: 'code';
  text: string;
  hasClosingBrackets: boolean;
}
export type Chunk = TextChunk | CodeChunk;

const OPEN = /\{\{/;
const CLOSE = /\}\}/;

function escapeCode(text: string): string {
  return text.replace('\\}}', '}}');
}

function normalizeBackslashes(text: string): string {
  return text.replace(/\\\\/g, '\\');
}

export function splitExpression(expression: string): Chunk[] {
  const chunks: Chunk[] = [];
  let searchingFor: 'open' | 'close' = 'open';
  let active = OPEN;
  let buffer = '';
  let index = 0;
  while (index < expression.length) {
    const expr = expression.slice(index);
    const res = active.exec(expr);
    if (!res) {
      buffer += expr;
      if (searchingFor === 'open') chunks.push({ type: 'text', text: buffer });
      else chunks.push({ type: 'code', text: escapeCode(buffer), hasClosingBrackets: false });
      break;
    }
    const before = expr.slice(0, res.index);
    const backslashes = before.match(/\\*$/)?.[0].length ?? 0;
    if (backslashes % 2 === 1) {
      buffer += expr.slice(0, res.index + 2);
      index += res.index + 2;
      continue;
    }
    buffer += before;
    if (searchingFor === 'open') {
      chunks.push({ type: 'text', text: normalizeBackslashes(buffer) });
      searchingFor = 'close';
      active = CLOSE;
    } else {
      chunks.push({ type: 'code', text: escapeCode(buffer), hasClosingBrackets: true });
      searchingFor = 'open';
      active = OPEN;
    }
    index += res.index + 2;
    buffer = '';
  }
  return chunks;
}

/** Is the parameter value an expression (string with a leading `=`)? */
export function isExpression(value: unknown): value is string {
  return typeof value === 'string' && value.charAt(0) === '=';
}

/** Returns the code parts of all expressions in a (nested) parameter value */
export function collectExpressions(
  value: unknown,
  path = '',
  out: Array<{ path: string; expression: string }> = [],
): Array<{ path: string; expression: string }> {
  if (isExpression(value)) {
    out.push({ path, expression: value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectExpressions(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectExpressions(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

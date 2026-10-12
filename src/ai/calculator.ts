// Rechner für das Calculator-Tool. n8n nutzt LangChain Calculator mit dem Paket expr-eval
// (Parser.evaluate). Nachgebaut ist die übliche Arithmetik: + - * / % ^, Klammern, Vorzeichen, Fakultät (!),
// Vergleiche, Konstanten (PI, E) und die Funktionen von expr-eval. Siehe docs/DEVIATIONS.md.

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  abs: Math.abs, acos: Math.acos, acosh: Math.acosh, asin: Math.asin, asinh: Math.asinh, atan: Math.atan, atanh: Math.atanh,
  cbrt: Math.cbrt, ceil: Math.ceil, cos: Math.cos, cosh: Math.cosh, exp: Math.exp, expm1: Math.expm1, floor: Math.floor,
  ln: Math.log, log: Math.log, log10: Math.log10, lg: Math.log10, log2: Math.log2, log1p: Math.log1p, round: Math.round,
  sign: Math.sign, sin: Math.sin, sinh: Math.sinh, sqrt: Math.sqrt, tan: Math.tan, tanh: Math.tanh, trunc: Math.trunc,
  min: Math.min, max: Math.max, hypot: Math.hypot, pow: Math.pow, atan2: Math.atan2,
  random: (n = 1) => Math.random() * n,
  fac: (n) => factorial(n),
  roundTo: (x, n = 0) => Number(Math.round(Number(`${x}e${n}`)) + `e-${n}`),
};
const CONSTANTS: Record<string, number> = { PI: Math.PI, E: Math.E, true: 1, false: 0 };

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(==|!=|>=|<=|\|\||&&|[-+*/%^!(),<>?:])/.exec(src.slice(i));
    if (!op) throw new Error(`Unexpected character "${c}"`);
    out.push({ t: 'op', v: op[0] });
    i += op[0].length;
  }
  return out;
}

export function evaluateExpression(src: string): number | boolean {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    pos++;
  };
  // Grammatik nach expr-eval: ternär > or > and > Vergleich > Summe > Produkt > unär > Potenz > Fakultät
  const ternary = (): number => {
    const cond = or();
    if (isOp('?')) {
      pos++;
      const a = ternary();
      expect(':');
      const b = ternary();
      return cond ? a : b;
    }
    return cond;
  };
  const or = (): number => {
    let l = and();
    while (isOp('||') || (peek()?.t === 'id' && peek()!.v === 'or')) {
      pos++;
      const r = and();
      l = Number(Boolean(l) || Boolean(r));
    }
    return l;
  };
  const and = (): number => {
    let l = comparison();
    while (isOp('&&') || (peek()?.t === 'id' && peek()!.v === 'and')) {
      pos++;
      const r = comparison();
      l = Number(Boolean(l) && Boolean(r));
    }
    return l;
  };
  const comparison = (): number => {
    let l = sum();
    for (;;) {
      const t = peek();
      if (t?.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) {
        pos++;
        const r = sum();
        l = Number(t.v === '==' ? l === r : t.v === '!=' ? l !== r : t.v === '<' ? l < r : t.v === '>' ? l > r : t.v === '<=' ? l <= r : l >= r);
      } else return l;
    }
  };
  const sum = (): number => {
    let l = product();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].v;
      const r = product();
      l = op === '+' ? l + r : l - r;
    }
    return l;
  };
  const product = (): number => {
    let l = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[pos++].v;
      const r = unary();
      l = op === '*' ? l * r : op === '/' ? l / r : l % r;
    }
    return l;
  };
  const unary = (): number => {
    if (isOp('-')) {
      pos++;
      return -unary();
    }
    if (isOp('+')) {
      pos++;
      return unary();
    }
    if (peek()?.t === 'id' && peek()!.v === 'not') {
      pos++;
      return Number(!unary());
    }
    return power();
  };
  const power = (): number => {
    const base = postfix();
    if (isOp('^')) {
      pos++;
      return Math.pow(base, unary());
    }
    return base;
  };
  const postfix = (): number => {
    let v = primary();
    while (isOp('!')) {
      pos++;
      v = factorial(v);
    }
    return v;
  };
  const primary = (): number => {
    const t = tokens[pos++];
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = ternary();
      expect(')');
      return v;
    }
    if (t.t === 'id') {
      if (isOp('(')) {
        pos++;
        const args: number[] = [];
        if (!isOp(')')) {
          args.push(ternary());
          while (isOp(',')) {
            pos++;
            args.push(ternary());
          }
        }
        expect(')');
        const fn = FUNCTIONS[t.v];
        if (!fn) throw new Error(`undefined function: ${t.v}`);
        return fn(...args);
      }
      if (t.v in CONSTANTS) return CONSTANTS[t.v];
      const fn = FUNCTIONS[t.v];
      if (fn) return fn(unary());
      throw new Error(`undefined variable: ${t.v}`);
    }
    throw new Error(`Unexpected token "${t.v}"`);
  };
  const result = ternary();
  if (pos < tokens.length) throw new Error(`Unexpected token "${tokens[pos].v}"`);
  return result;
}

/** LangChain Calculator._call: Ergebnis als Text, bei Fehlern ein fester Satz */
export function calculate(input: unknown): string {
  try {
    return String(evaluateExpression(String(input)));
  } catch {
    return "I don't know how to do that.";
  }
}

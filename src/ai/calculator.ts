// Calculator for the Calculator tool. n8n 1.123.0 uses the LangChain calculator (@langchain/community 1.0.5,
// tools/calculator.js), which calls math-expression-evaluator 2.0.7: Parser.eval(input).toString().
// Same library, hence same syntax and same results (e.g. angles in degrees, 1/3 = 0.333333333333333).
import mexp from 'math-expression-evaluator';

// The package has no "type": "module"; TypeScript therefore sees the default export as a module namespace,
// at runtime it is the class.
const Mexp = mexp as unknown as new () => { eval(input: string): number };
const parser = new Mexp();

/** Calculator._call: result as text, a fixed sentence on errors */
export function calculate(input: unknown): string {
  try {
    return parser.eval(String(input)).toString();
  } catch {
    return "I don't know how to do that.";
  }
}

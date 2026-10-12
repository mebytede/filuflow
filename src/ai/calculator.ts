// Rechner für das Calculator-Tool. n8n 1.123.0 nutzt den LangChain-Calculator (@langchain/community 1.0.5,
// tools/calculator.js), der math-expression-evaluator 2.0.7 aufruft: Parser.eval(input).toString().
// Gleiche Bibliothek, daher gleiche Syntax und gleiche Ergebnisse (z. B. Winkel in Grad, 1/3 = 0.333333333333333).
import mexp from 'math-expression-evaluator';

// Das Paket hat kein "type": "module"; TypeScript sieht den Default-Export daher als Modul-Namensraum,
// zur Laufzeit ist er die Klasse.
const Mexp = mexp as unknown as new () => { eval(input: string): number };
const parser = new Mexp();

/** Calculator._call: Ergebnis als Text, bei Fehlern ein fester Satz */
export function calculate(input: unknown): string {
  try {
    return parser.eval(String(input)).toString();
  } catch {
    return "I don't know how to do that.";
  }
}

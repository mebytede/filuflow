// Eingaben für scripts/record-ai-tools-oracle.sh
export const CALCULATOR = [
  '21*2', '7^2', '2+3*4', '(2+3)*4', '1/3', '2/0', '-5+2', '5!', '10 Mod 3', '10%3', 'sqrt(16)', 'root 16', 'root(16)',
  'sin(90)', 'cos(0)', 'tan(45)', 'log 100', 'ln 1', 'pi', 'pi*2', 'e', '2e3', '1.5*2', '0.1+0.2', '3^-1', '2^3^2',
  'abc', '', '   ', '1+', '(1+2', '1 + 2 * (3 - 1) / 4', '12.5%', '50% of 200', '100*5%', 'C(5,2)', 'P(5,2)', '5C2',
  'Sigma(1,3,n)', 'Pi(1,4,n)', 'asin(1)', 'acos(1)', 'atan(1)', 'sinh(0)', 'int 3.7', '3.7 int', '|-3|', 'abs(-3)',
  '1,000 + 1', '1000000*1000000', '0.000001*0.000001', '2**3', 'x+1', '7 hoch 2', '21 * 2 = ?', '((3))', '4/2/2', '-(-3)',
];
export const FROM_AI = [
  "={{ $fromAI('a') }}",
  "={{ $fromAI('a', 'Erste Zahl', 'number') }}",
  "={{ $fromAI('flag', 'Schalter', 'boolean', true) }}",
  "={{ $fromAI('n', 'Anzahl', 'number', 5) }}",
  "={{ $fromAI('s', 'Text', 'string', 'hallo') }}",
  "={{ $fromAI('obj', 'Daten', 'json') }}",
  "={{ $fromAI('obj', 'Daten', 'json', '{\"x\":1}') }}",
  "={{ $fromAI(\"dq\", \"mit \\\"Zitat\\\"\", \"string\") }}",
  "={{ $fromAI(`bt`, `Backtick, mit Komma`) }}",
  "={{ $fromAI('a', 'x') }} und {{ $fromAI('b', 'y', 'number') }}",
  "={{ $fromAI('a', 'erst') }} {{ $fromAI('a', 'zweit', 'number') }}",
  "={{ $fromai('klein') }}",
  "={{ $fromAI('t', 'Typ', 'date') }}",
  "={{ $fromAI('k', 'Klammer (innen)', 'string') }}",
  "={{ $fromAI('k', 'ohne Ende' }}",
  "={{ $fromAI( 'leer' , '' ) }}",
  "={{ $fromAI('b', 'bool', 'boolean', 'ja') }}",
  "={{ $fromAI('n', 'num', 'number', 'abc') }}",
  'kein Platzhalter',
];

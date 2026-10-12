// Erzeugt Testfälle für Orakel-Tabellen (Filter-Operatoren), die mit echtem n8n ausgewertet werden.
export function filterCases() {
  const values = [
    null, undefined, '', ' ', '0', '1', '5', '5.5', 'abc', 'ABC', 'true', 'false', 'TRUE',
    0, 1, 5, -1, 5.5, true, false, [], [1, 'a'], ['A', 'b'], {}, { a: 1 },
    '2024-01-01', '2024-01-01T10:00:00.000Z', '2023-12-31T23:59:59Z', 'not a date', 'Mon, 01 Jan 2024 00:00:00 GMT',
    '/^a/i', '[1,2]', '{"a":1}',
  ];
  const ops = {
    string: ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith', 'regex', 'notRegex', 'empty', 'notEmpty', 'exists', 'notExists'],
    number: ['equals', 'notEquals', 'gt', 'lt', 'gte', 'lte', 'empty', 'notEmpty', 'exists', 'notExists', 'contains'],
    boolean: ['equals', 'notEquals', 'true', 'false', 'empty', 'notEmpty', 'exists', 'notExists'],
    dateTime: ['equals', 'notEquals', 'after', 'before', 'afterOrEquals', 'beforeOrEquals', 'empty', 'notEmpty', 'exists', 'notExists'],
    array: ['contains', 'notContains', 'lengthEquals', 'lengthNotEquals', 'lengthGt', 'lengthLt', 'lengthGte', 'lengthLte', 'empty', 'notEmpty', 'exists', 'notExists'],
    object: ['empty', 'notEmpty', 'exists', 'notExists', 'equals'],
  };
  const singleValue = new Set(['empty', 'notEmpty', 'exists', 'notExists', 'true', 'false']);
  const rightFor = {
    string: ['', 'a', 'abc', 'B', '^a', '/^A/i', 5, null],
    number: [5, '5', 0, '', null, 'x'],
    boolean: [true, false, 'true', 1, null],
    dateTime: ['2024-01-01', '2024-01-01T10:00:00.000Z', 'x', null],
    array: [1, 'a', 'A', 2, '2', null],
    object: [{}, null],
  };
  const cases = [];
  for (const [type, operations] of Object.entries(ops)) {
    for (const operation of operations) {
      const rights = singleValue.has(operation) ? [undefined] : rightFor[type];
      for (const left of values) {
        for (const right of rights) {
          for (const typeValidation of ['strict', 'loose']) {
            for (const version of type === 'boolean' ? [1, 2] : type === 'number' ? [1, 3] : [1]) {
              for (const caseSensitive of type === 'string' || type === 'array' ? [true, false] : [true]) {
                const operator = { type, operation };
                if (singleValue.has(operation)) operator.singleValue = true;
                if (type === 'array' && operation.startsWith('length')) operator.rightType = 'number';
                if (type === 'array' && (operation === 'contains' || operation === 'notContains')) operator.rightType = 'any';
                cases.push({ condition: { leftValue: left, rightValue: right, operator }, options: { caseSensitive, typeValidation, version } });
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

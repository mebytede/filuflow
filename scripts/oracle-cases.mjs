// Generates test cases for oracle tables (filter operators) that are evaluated with the real reference implementation.
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

/** Data for $json in expression cases */
export const EXPRESSION_DATA = {
  s: 'hello world. this is n8n! ok?',
  t: '  Mixed Case  Text ',
  num: 1234.5678,
  int: 7,
  neg: -3,
  zero: 0,
  bool: true,
  arr: [3, 1, 2, 3, 1],
  sarr: ['b', 'a', 'c', 'a'],
  objs: [{ id: 1, name: 'a', v: 10 }, { id: 2, name: 'b', v: 20 }, { id: 1, name: 'a', v: 30 }, { name: 'c' }],
  obj: { a: 1, b: '', c: null, d: { e: 'x', f: {} }, g: 'nil', h: 'contains n8n' },
  email: 'Max Mustermann <max.muster@example.co.uk> schrieb',
  url: 'https://www.sub.example.com:8080/path/to/page?q=1#frag',
  iso: '2024-03-15T10:30:00.000Z',
  isoLocal: '2024-03-15T10:30:00',
  date: '2024-03-15',
  md: '# Titel\n\n**fett** und _kursiv_ [Link](http://x.y) `code`\n- Punkt',
  html: '<p>Hallo <b>Welt</b></p>',
  currency: '€1,234.50',
  numstr: '42.5',
  b64: 'SGFsbG8gV2VsdA==',
  umlaut: 'Äpfel Über Straße',
  jsonstr: '{"a":[1,2],"b":"x"}',
  nested: { list: [{ k: 'x', v: 1 }, { k: 'y', v: 2 }] },
  empty: '',
  emptyArr: [],
  emptyObj: {},
};

export function extensionCases() {
  const c = [];
  const add = (...tpls) => c.push(...tpls);
  // String
  for (const fn of ['toTitleCase()', 'toSentenceCase()', 'toSnakeCase()', 'removeTags()', 'toJsonString()', 'length()', 'isEmpty()', 'isNotEmpty()', 'urlEncode()', 'urlEncode(true)', 'quote()', "quote(\"'\")", 'replaceSpecialChars()', 'hash()', "hash('sha1')", "hash('sha256')", "hash('sha512')", "hash('sha3')", "hash('base64')", "hash('xyz')", 'base64Encode()', 'isNumeric()', 'isEmail()', 'isUrl()', 'isDomain()', 'extractEmail()', 'extractDomain()', 'extractUrl()', 'extractUrlPath()', 'toBoolean()', 'toNumber()', 'toFloat()', 'toInt()', 'toDecimalNumber()', 'toWholeNumber()', 'removeMarkdown()', 'parseJson()', 'toDateTime()', 'toDate()']) {
    for (const field of ['s', 't', 'email', 'url', 'iso', 'isoLocal', 'date', 'md', 'html', 'currency', 'numstr', 'umlaut', 'jsonstr', 'empty']) add(`{{ $json.${field}.${fn} }}`);
  }
  add('{{ $json.b64.base64Decode() }}', '{{ "a%20b%2Fc".urlDecode() }}', '{{ "a%20b%2Fc".urlDecode(true) }}', '{{ "ff".toInt(16) }}', '{{ "15.03.2024".toDateTime("dd.MM.yyyy").toISO() }}', '{{ "1710498600".toDateTime("s").toISO() }}', '{{ "45000".toDateTime("excel").toISO() }}', '{{ "yes".toBoolean() }}', '{{ "no".toBoolean() }}', '{{ "0".toBoolean() }}', '{{ "False".toBoolean() }}', '{{ "  ".isEmpty() }}', '{{ "kontakt@firma.de".extractDomain() }}', '{{ "http://localhost:3000/x".extractDomain() }}', '{{ "www.example.org".isDomain() }}', '{{ "1e3".isNumeric() }}', '{{ "1 2".isNumeric() }}');
  // Number
  for (const fn of ['round()', 'round(2)', 'floor()', 'ceil()', 'abs()', 'isInteger()', 'isEven()', 'isOdd()', 'toBoolean()', 'toInt()', 'toFloat()', 'format()', "format('de-DE')", "format('en-US', { style: 'currency', currency: 'EUR' })", 'toDateTime().toISO()', "toDateTime('s').toISO()", 'isEmpty()', 'isNotEmpty()', 'toJsonString()']) {
    for (const field of ['num', 'int', 'neg', 'zero']) add(`{{ $json.${field}.${fn} }}`);
  }
  add('{{ (5).toDateTime("us").toISO() }}', '{{ (45000).toDateTime("excel").toISO() }}', '{{ (1).toDateTime("x") }}');
  // Boolean
  for (const fn of ['toInt()', 'toFloat()', 'toNumber()', 'toBoolean()', 'toDateTime()', 'isEmpty()', 'isNotEmpty()']) add(`{{ $json.bool.${fn} }}`, `{{ false.${fn} }}`);
  // Array
  for (const fn of ['first()', 'last()', 'unique()', 'removeDuplicates()', "unique('id')", "pluck('name')", "pluck('id', 'v')", 'pluck()', 'sum()', 'min()', 'max()', 'average()', 'isEmpty()', 'isNotEmpty()', 'compact()', "smartJoin('name', 'v')", 'chunk(2)', 'chunk(0)', "renameKeys('name', 'titel')", 'merge()', "merge([{ x: 1 }])", 'union([3, 4, 5])', 'difference([1, 9])', 'intersection([1, 2, 9])', 'append(9, 8)', 'toJsonString()', 'toInt()', 'toDateTime()', 'length']) {
    for (const field of ['arr', 'sarr', 'objs', 'emptyArr']) add(`{{ $json.${field}.${fn} }}`);
  }
  add('{{ $json.nested.list.smartJoin("k", "v") }}', '{{ [1, "2", 3].sum() }}', '{{ [].average() }}', '{{ [[1], [1], [2]].unique() }}');
  // Object
  for (const fn of ['isEmpty()', 'isNotEmpty()', 'keys()', 'values()', "hasField('a')", "hasField('z')", "removeField('a')", "removeFieldsContaining('n8n')", "keepFieldsContaining('n8n')", "removeFieldsContaining('')", 'compact()', 'urlEncode()', 'toJsonString()', 'toInt()', 'toBoolean()']) {
    for (const field of ['obj', 'emptyObj', 'nested']) add(`{{ $json.${field}.${fn} }}`);
  }
  // Date / DateTime
  const dts = ['DateTime.fromISO("2024-03-15T10:30:00.000Z")', 'DateTime.fromISO("2024-07-06T23:15:00", { zone: "Europe/Berlin" })', 'new Date("2024-03-15T10:30:00.000Z")', '$json.iso'];
  for (const d of dts) {
    for (const fn of ['beginningOf("month")', 'beginningOf()', 'beginningOf("days")', 'endOfMonth()', 'extract("year")', 'extract()', 'extract("yearDayNumber")', 'extract("weekday")', 'extract("hour")', 'format("yyyy-MM-dd HH:mm")', 'format("cccc d. LLLL", { locale: "de" })', 'isDst()', 'isWeekend()', 'plus(1, "day")', 'plus({ hours: 5 })', 'minus(2, "months")', 'minus(30)', 'toInt()', 'toFloat()', 'isEmpty()', 'isNotEmpty()', 'isBetween("2024-01-01", "2024-12-31")', 'isBetween("2025-01-01", "2024-01-01")', 'diffTo("2024-01-01T00:00:00.000Z", "days")', 'diffTo("2024-01-01T00:00:00.000Z", ["months", "days"])', 'diffTo("2024-01-01T00:00:00.000Z", "foo")', 'toDateTime()']) {
      add(`{{ ${d}.${fn} }}`);
    }
  }
  // Generic and special cases
  // General expression semantics
  add('a {{ $json.obj }}', '{{ $json.obj }}', '{{ DateTime.fromISO("2024-01-01T00:00:00.000Z") }} x', '{{ [1, [2, 3]] }}x', '{{ $json.gibts.tief }}', 'x{{ $json.gibts.tief }}y', '{{ 1 + }}', '{{ $json["s"] }}', '{{ $json.constructor }}', '{{ (() => 5)() }}', '{{ (function () { return 1 })() }}', '{{ typeof $json }}', '{{ $json.s.replace(/o/g, "0") }}', '{{ JSON.stringify($json.obj) }}', '{{ new Date(0).toISOString() }}', '{{ $json.arr.map(x => x * 2).join("-") }}', '{{ Object.entries($json.obj).length }}', '{{ $json.empty || "fallback" }}', '{{ `template ${$json.int}` }}', '{{ $json.num.toFixed(2) }}', '{{ $json.objs.find(o => o.id === 2).name }}', '{{ $json.objs.filter(o => o.id === 1).length }}', '{{ $json.int ?? 5 }}', '{{ { a: 1 } }}', '{{ [] }}', '{{ "" }}', 'nur text', '{{ $json.s.split(" ") }}', '{{ $input.item.json.int }}', '{{ $itemIndex }}', '{{ $runIndex }}', '{{ $workflow.name }}', '{{ $execution.mode }}', '{{ $json.int > 3 && $json.bool }}', '{{ null }}{{ undefined }}{{ false }}{{ 0 }}', '{{ $json.arr.length > 2 ? "viel" : "wenig" }}', '{{ String($json.int).padStart(3, "0") }}', '{{ parseInt("08", 10) + parseFloat("1.5") }}', '{{ Math.round($json.num * 100) / 100 }}', '{{ encodeURIComponent($json.url) }}', '{{ $json.sarr.sort() }}', '{{ $json.s.match(/\\w+/g).length }}', '{{ new Set($json.arr).size }}', '{{ Array.from({ length: 3 }, (_, i) => i) }}', '{{ $json.s.toUpperCase() }}', '{{ $json.s.substring(0, 5) }}', '{{ $json.t.trim().split(/\\s+/) }}', '{{ $json["obj"]["d"]["e"] }}', '{{ $json.obj.d?.f?.g }}', '{{ $json.objs[1]?.name }}', '{{ $jmespath($json.objs, "[?id==`1`].v") }}', '{{ $min(1, 2) }}{{ $max(3, 4) }}', '{{ $ifEmpty($json.emptyArr, "leer") }}', '{{ $if($json.zero, "ja", "nein") }}', '{{ Duration.fromObject({ hours: 2 }).as("minutes") }}', '{{ DateTime.fromISO("2024-02-29").plus({ years: 1 }).toISODate() }}', '{{ $json.missing.name }}', '{{ $json.missing }}', 'Wert: {{ $json.missing }}!');
  add('{{ null.isEmpty() }}', '{{ $json.gibts?.isEmpty() }}', '{{ $json.gibts.isEmpty() }}', '{{ $json.gibts.first() }}', '{{ $json.gibts?.first() }}', '{{ $json.int.toTitleCase() }}', '{{ $json.s.sum() }}', '{{ $json.s.gibtsNicht() }}', '{{ $json.s.toUpperCase().toTitleCase() }}', '{{ $json.objs.pluck("v").sum().round(1) }}', '{{ $if($json.int > 5, "gross", "klein") }}', '{{ $json.s.split(" ").first() }}', '{{ $json.sarr.unique().length }}', '{{ $json.objs[0]?.name?.toTitleCase() }}', '{{ "abc".includes("b") }}', '{{ [1,2,3].includes(2) }}', '{{ $json.obj.keys().length }}', '{{ $json.iso.toDateTime().plus(1, "week").toISO() }}', '{{ $json.iso.toDateTime().minus(1, "hrs").format("HH:mm") }}', '{{ $ifEmpty($json.empty, "leer") }}', '{{ $json.objs.map(o => o.name).compact().unique() }}', '{{ Math.max(...$json.arr) }}', '{{ $json.num.format("de-DE", { maximumFractionDigits: 1 }) }}', '{{ $json.s.length }}');
  return c;
}

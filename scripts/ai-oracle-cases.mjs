// Testfälle für das KI-Orakel (scripts/record-ai-oracle.sh): JSON-Beispiele, JSON-Schemas und
// Modellantworten für den Structured Output Parser.
export const EXAMPLES = [
  '{"name":"Ada","alter":36}',
  '{"a":1.5,"b":true,"c":null,"d":[1,2],"e":[{"x":"y"}],"f":{"g":{"h":"i"}}}',
  '{"leer":[],"gemischt":[1,"a"],"datum":"2024-01-01T00:00:00Z","int":3,"neg":-2}',
  '[{"x":1,"y":"z"}]',
  '{"objs":[{"a":1},{"b":2}],"tief":[[1,2],[3]]}',
  '{"state":"California","cities":["Los Angeles","San Francisco","San Diego"]}',
  '"nur text"',
  '{"leeresObjekt":{},"bool":false,"zahl":0}',
];

export const SCHEMAS = [
  { type: 'object', properties: { state: { type: 'string' }, cities: { type: 'array', items: { type: 'string' } } } },
  {
    type: 'object',
    properties: {
      sentiment: { type: 'string', enum: ['positiv', 'negativ', 'neutral'], description: 'Die Stimmung' },
      score: { type: 'number', minimum: 0, maximum: 1 },
      anzahl: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      notiz: { type: ['string', 'null'] },
    },
    required: ['sentiment', 'score'],
  },
  {
    type: 'object',
    properties: {
      person: {
        type: 'object',
        properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } },
        required: ['name'],
        additionalProperties: true,
      },
      datum: { type: 'string', format: 'date-time' },
      wahl: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      standard: { type: 'string', default: 'x' },
      fest: { const: 'immer' },
    },
  },
  { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { type: 'string' },
];

export const TEXTS = [
  '{"output":{"name":"Ada","alter":36}}',
  '```json\n{"output": {"name": "Ada", "alter": 36, "extra": true}}\n```',
  'Hier ist das Ergebnis:\n```\n{"output":{"name":"Ada","alter":"36"}}\n```\nViel Spaß',
  '{"name":"Ada","alter":36}',
  '{}',
  'kein json',
  '{"output":{"output":{"name":"Ada","alter":36}}}',
  '{"output":[{"x":1,"y":"z"}]}',
  '{"output":"nur text"}',
  '{"output":{"state":"Bayern","cities":["München"],"extra":1}}',
  '{"output":{"sentiment":"positiv","score":0.9,"anzahl":2,"tags":["a"],"notiz":null}}',
  '{"output":{"sentiment":"froh","score":2}}',
  '{"output":{"sentiment":"neutral","score":0.5,"anzahl":1.5}}',
  '{"output":{"person":{"name":"Bo","email":"bo@example.com","x":1},"datum":"2024-01-01T10:00:00Z","wahl":3,"fest":"immer"}}',
  '{"output":{"person":{"name":"Bo","email":"kaputt"},"datum":"gestern","fest":"anders"}}',
  '{"output":[{"id":1,"rest":2},{"id":2}]}',
  '{"__structured__output":{"__structured__output__object":{"name":"Ada","alter":36}}}',
  '{"__structured__output":{"__structured__output__array":[{"x":1,"y":"z"}]}}',
];

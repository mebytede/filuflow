// Initial values for newly inserted nodes. These are suggestions of the interface, not reference defaults:
// the node implementations handle missing parameters with the defaults from the reference source code.
import { newId } from './model.js';

type Template = (version: number) => Record<string, unknown>;

const condition = () => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions: [{ id: newId(), leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } }],
  combinator: 'and',
});

const TEMPLATES: Record<string, Template> = {
  'n8n-nodes-base.webhook': () => ({ httpMethod: 'POST', path: newId(), options: {} }),
  'n8n-nodes-base.scheduleTrigger': () => ({ rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }),
  'n8n-nodes-base.set': () => ({ assignments: { assignments: [{ id: newId(), name: 'field', value: '', type: 'string' }] }, options: {} }),
  'n8n-nodes-base.if': () => ({ conditions: condition(), options: {} }),
  'n8n-nodes-base.filter': () => ({ conditions: condition(), options: {} }),
  'n8n-nodes-base.code': () => ({
    jsCode: "// Loop over all items and add a field\nfor (const item of $input.all()) {\n  item.json.newField = 1;\n}\n\nreturn $input.all();",
  }),
  'n8n-nodes-base.httpRequest': () => ({ url: 'https://example.com', options: {} }),
  'n8n-nodes-base.limit': () => ({ maxItems: 1 }),
  'n8n-nodes-base.splitOut': () => ({ fieldToSplitOut: '', options: {} }),
  'n8n-nodes-base.aggregate': () => ({ fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: '' }] }, options: {} }),
  'n8n-nodes-base.respondToWebhook': () => ({ options: {} }),
  'n8n-nodes-base.stopAndError': () => ({ errorMessage: 'An error occurred' }),
  'n8n-nodes-base.wait': () => ({ amount: 1 }),
  'n8n-nodes-base.stickyNote': () => ({ content: '## Note\nText in Markdown', height: 160, width: 260 }),
  'n8n-nodes-base.executeWorkflow': () => ({ source: 'database', workflowId: { __rl: true, value: '', mode: 'id' }, options: {} }),
  '@n8n/n8n-nodes-langchain.chatTrigger': () => ({ options: {} }),
  'n8n-nodes-base.formTrigger': () => ({ formTitle: 'Form', formFields: { values: [{ fieldLabel: 'Name', requiredField: true }] }, options: {} }),
  'n8n-nodes-base.form': () => ({ operation: 'page', formFields: { values: [{ fieldLabel: 'Field' }] }, options: {} }),
  '@n8n/n8n-nodes-langchain.chainLlm': () => ({ promptType: 'define', text: '={{ $json.text }}', batching: {} }),
  '@n8n/n8n-nodes-langchain.agent': () => ({ promptType: 'define', text: '={{ $json.text }}', options: {} }),
  '@n8n/n8n-nodes-langchain.lmChatOpenAi': () => ({ model: { __rl: true, value: 'gpt-4o-mini', mode: 'list' }, options: {} }),
  '@n8n/n8n-nodes-langchain.lmChatAnthropic': () => ({ model: { __rl: true, value: 'claude-sonnet-4-5-20250929', mode: 'list' }, options: {} }),
  '@n8n/n8n-nodes-langchain.lmChatGoogleGemini': () => ({ modelName: 'models/gemini-2.5-flash', options: {} }),
  '@n8n/n8n-nodes-langchain.memoryBufferWindow': () => ({ sessionIdType: 'customKey', sessionKey: 'session', contextWindowLength: 5 }),
  '@n8n/n8n-nodes-langchain.outputParserStructured': () => ({ jsonSchemaExample: '{\n  "name": "Ada",\n  "age": 36\n}' }),
  '@n8n/n8n-nodes-langchain.toolCode': () => ({ description: 'Description for the model', language: 'javaScript', jsCode: 'return query;' }),
  '@n8n/n8n-nodes-langchain.informationExtractor': () => ({ text: '={{ $json.text }}', schemaType: 'fromJson', jsonSchemaExample: '{\n  "name": ""\n}', options: {} }),
  '@n8n/n8n-nodes-langchain.textClassifier': () => ({
    inputText: '={{ $json.text }}',
    categories: { categories: [{ category: 'A', description: '' }, { category: 'B', description: '' }] },
    options: {},
  }),
  '@n8n/n8n-nodes-langchain.sentimentAnalysis': () => ({ inputText: '={{ $json.text }}', options: {} }),
};

/** Starter code per language and mode (Code node, Code Tool) */
export function codeTemplate(type: string, language: string, mode: string): string {
  if (type === '@n8n/n8n-nodes-langchain.toolCode') return language === 'python' ? 'return query.upper()' : 'return query;';
  const each = mode === 'runOnceForEachItem';
  if (language === 'python') {
    return each
      ? "# Runs for each item; _json is the current item\n_json['newField'] = 1\nreturn _json"
      : '# Loop over all items and add a field\nfor item in _input.all():\n    item.json.newField = 1\n\nreturn _input.all()';
  }
  if (language === 'pythonNative') {
    return each
      ? "# Runs for each item; _item is a dict\n_item['json']['newField'] = 1\nreturn _item"
      : "# _items is a list of dicts\nfor item in _items:\n    item['json']['newField'] = 1\n\nreturn _items";
  }
  return each
    ? '// Runs for each item\n$input.item.json.newField = 1;\n\nreturn $input.item;'
    : '// Loop over all items and add a field\nfor (const item of $input.all()) {\n  item.json.newField = 1;\n}\n\nreturn $input.all();';
}

export function templateFor(type: string, version: number): Record<string, unknown> {
  return TEMPLATES[type]?.(version) ?? {};
}

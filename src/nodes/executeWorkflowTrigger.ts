// When Executed by Another Workflow, n8n-nodes-base.executeWorkflowTrigger (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflowTrigger
// v1: Daten werden durchgereicht. v1.1: Default "workflowInputs" (nur definierte Felder, fehlende = null).
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { jsonParse } from './shared/utils.js';
import type { ParamSchema } from './params.js';

// Parameter wie packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflowTrigger/ExecuteWorkflowTrigger.node.ts
// und utils/workflowInputsResourceMapping/constants.ts (TYPE_OPTIONS). n8n prüft die Version mit { eq: 1 }.
const parameters: ParamSchema[] = [
  { name: 'events', label: 'Ereignisse', type: 'hidden', noExpression: true, default: 'worklfow_call' },
  {
    name: 'notice',
    label: 'Ruft ein Execute-Workflow-Knoten diesen Workflow auf, startet die Ausführung hier. Alle übergebenen Daten gibt dieser Knoten aus.',
    type: 'notice',
    default: '',
    show: { '@version': [1] },
  },
  {
    name: 'outdatedVersionWarning',
    label: 'Dieser Knoten ist veraltet. Bitte entfernen Sie ihn und fügen Sie einen neuen hinzu.',
    type: 'notice',
    default: '',
    show: { '@version': [1] },
  },
  {
    name: 'inputSource',
    label: 'Eingabedaten',
    type: 'options',
    noExpression: true,
    default: 'workflowInputs',
    options: [
      { value: 'workflowInputs', label: 'Über Felder festlegen', description: 'Eingabefelder im Formular angeben' },
      { value: 'jsonExample', label: 'Über JSON-Beispiel festlegen', description: 'Schema aus einem JSON-Beispielobjekt ableiten' },
      { value: 'passthrough', label: 'Alle Daten annehmen', description: 'Alle Daten des aufrufenden Workflows übernehmen' },
    ],
    show: { '@version': [{ _cnd: { gte: 1.1 } }] },
  },
  {
    name: 'jsonExample_notice',
    label: 'Geben Sie ein Beispielobjekt an, aus dem Felder und Typen abgeleitet werden. Mit dem Wert null ist jeder Typ erlaubt.',
    type: 'notice',
    default: '',
    show: { '@version': [{ _cnd: { gte: 1.1 } }], inputSource: ['jsonExample'] },
  },
  {
    name: 'jsonExample',
    label: 'JSON-Beispiel',
    type: 'json',
    noExpression: true,
    default: JSON.stringify({ aField: 'a string', aNumber: 123, thisFieldAcceptsAnyType: null, anArray: [] }, null, 2),
    show: { '@version': [{ _cnd: { gte: 1.1 } }], inputSource: ['jsonExample'] },
  },
  {
    name: 'workflowInputs',
    label: 'Eingabeschema des Workflows',
    type: 'fixedCollection',
    multiple: true,
    addLabel: 'Feld hinzufügen',
    default: {},
    description: 'Erwartete Eingabefelder; ohne Felder werden alle Daten durchgereicht',
    show: { '@version': [{ _cnd: { gte: 1.1 } }], inputSource: ['workflowInputs'] },
    groups: [
      {
        name: 'values',
        label: 'Werte',
        children: [
          {
            name: 'name',
            label: 'Name',
            type: 'string',
            default: '',
            placeholder: 'z. B. fieldName',
            description: 'Eindeutiger Name der Eingabe, über den andere Workflows sie ansprechen',
            required: true,
            noExpression: true,
          },
          {
            name: 'type',
            label: 'Typ',
            type: 'options',
            default: 'string',
            options: [
              { value: 'any', label: 'Beliebiger Typ' },
              { value: 'string', label: 'String' },
              { value: 'number', label: 'Number' },
              { value: 'boolean', label: 'Boolean' },
              { value: 'array', label: 'Array' },
              { value: 'object', label: 'Object' },
            ],
            description: 'Erwarteter Datentyp der Eingabe',
            required: true,
            noExpression: true,
          },
        ],
      },
    ],
  },
];

export const executeWorkflowTriggerNode: NodeType = {
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  displayName: 'When Executed by Another Workflow',
  versions: [1, 1.1],
  parameters,
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  async execute(ctx) {
    const inputData = ctx.inputs[0] ?? [];
    const inputSource = ctx.node.typeVersion >= 1.1 ? ctx.getParam<string>('inputSource', 0, 'workflowInputs') : 'passthrough';
    if (inputSource === 'passthrough') return [inputData];
    let names: string[] = [];
    if (inputSource === 'workflowInputs') {
      names = ctx.getParam<Array<{ name?: string }>>('workflowInputs.values', 0, []).map((v) => v.name ?? '');
    } else if (inputSource === 'jsonExample') {
      const example = jsonParse<Record<string, unknown>>(ctx.getParam<string>('jsonExample', 0, '{}'));
      names = example && typeof example === 'object' && !Array.isArray(example) ? Object.keys(example) : [];
    }
    const keys = new Set(names);
    return [
      inputData.map(({ json, binary }, index) => ({
        json: { ...Object.fromEntries(names.map((n) => [n, null])), ...lodash.pickBy(json, (_v, k) => keys.has(k)) },
        index,
        ...(binary ? { binary } : {}),
      })) as Item[],
    ];
  },
};

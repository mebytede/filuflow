// n8n Form, n8n-nodes-base.form (typeVersion 1, 2.3): weitere Formularseite oder Abschluss nach einem Form Trigger.
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Form/Form.node.ts (execute: Form Trigger davor nötig, Abschluss
// muss der letzte Form-Knoten sein, Execution wartet und leitet per 307 auf $execution.resumeFormUrl weiter) und
// utils/formCompletionUtils.ts. Seiten und Auswertung: src/server/webhooks.ts mit src/nodes/shared/form.ts.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { NodeOperationError } from '../errors.js';
import { FORM_NODE_TYPE, FORM_TRIGGER_TYPE } from './shared/form.js';
import { formCustomCssParam, formDescriptionParam, formFieldsDefinitionParams, formTitleParam } from './shared/formParams.js';
import { WAIT_INDEFINITELY } from '../engine/executor.js';

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

// Parameter wie n8n Form.node.ts (properties mit pageProperties, completionProperties, waitTimeProperties) und
// utils/sendAndWait/descriptions.ts (limitWaitTimeProperties); Formularfelder aus shared/formParams.ts.
// updateDisplayOptions ergänzt dort show.operation; die Wartezeit-Parameter gelten für beide Seitentypen.
const PAGE = { operation: ['page'] };
const COMPLETION = { operation: ['completion'] };
const parameters: ParamSchema[] = [
  { name: 'triggerNotice', label: 'Vor diesem Knoten muss ein n8n Form Trigger stehen.', type: 'notice', default: '' },
  {
    name: 'operation',
    label: 'Seitentyp',
    type: 'options',
    default: 'page',
    noExpression: true,
    options: [
      { value: 'page', label: 'Nächste Formularseite' },
      { value: 'completion', label: 'Formularende' },
    ],
  },
  ...formFieldsDefinitionParams.map((p): ParamSchema => ({ ...p, show: { ...p.show, ...PAGE } })),
  {
    name: 'respondWith',
    label: 'Nach dem Absenden',
    type: 'options',
    default: 'text',
    show: COMPLETION,
    options: [
      { value: 'text', label: 'Abschlussseite zeigen', description: 'Zeigt einen Antworttext an' },
      { value: 'redirect', label: 'Auf URL weiterleiten', description: 'Leitet auf eine URL weiter' },
      { value: 'showText', label: 'Text zeigen', description: 'Zeigt einfachen Text oder HTML an' },
      { value: 'returnBinary', label: 'Binärdatei zurückgeben', description: 'Gibt die eingehende Binärdatei zurück' },
    ],
  },
  { name: 'redirectUrl', label: 'URL', type: 'string', default: '', required: true, show: { ...COMPLETION, respondWith: ['redirect'] } },
  { name: 'completionTitle', label: 'Abschlusstitel', type: 'string', default: '', required: true, show: { ...COMPLETION, respondWith: ['text', 'returnBinary'] } },
  { name: 'completionMessage', label: 'Abschlusstext', type: 'string', default: '', rows: 2, show: { ...COMPLETION, respondWith: ['text', 'returnBinary'] } },
  {
    name: 'responseText',
    label: 'Text',
    type: 'string',
    default: '',
    rows: 2,
    placeholder: 'z. B. Danke für das Ausfüllen',
    description: 'Text der Seite; mit HTML lässt sich die Seite gestalten',
    show: { ...COMPLETION, respondWith: ['showText'] },
  },
  {
    name: 'inputDataFieldName',
    label: 'Feld mit den Binärdaten',
    type: 'string',
    default: 'data',
    placeholder: 'z. B. data',
    description: 'Name des Eingabefelds mit der zurückzugebenden Datei',
    show: { ...COMPLETION, respondWith: ['returnBinary'] },
  },
  {
    name: 'limitWaitTime',
    label: 'Wartezeit begrenzen',
    type: 'boolean',
    default: false,
    description: 'Ob die Ausführung nach einer Höchstzeit ohne Antwort weiterläuft',
  },
  {
    name: 'limitType',
    label: 'Art der Begrenzung',
    type: 'options',
    default: 'afterTimeInterval',
    description: 'Ob nach einer Zeitspanne oder zu einem Zeitpunkt fortgesetzt wird',
    show: { limitWaitTime: [true] },
    options: [
      { value: 'afterTimeInterval', label: 'Nach Zeitspanne', description: 'Wartet eine bestimmte Zeit' },
      { value: 'atSpecifiedTime', label: 'Zu festem Zeitpunkt', description: 'Wartet bis zu Datum und Uhrzeit' },
    ],
  },
  {
    name: 'resumeAmount',
    label: 'Dauer',
    type: 'number',
    default: 1,
    min: 0,
    precision: 2,
    description: 'Wie lange gewartet wird',
    show: { limitWaitTime: [true], limitType: ['afterTimeInterval'] },
  },
  {
    name: 'resumeUnit',
    label: 'Einheit',
    type: 'options',
    default: 'hours',
    description: 'Einheit der Dauer',
    show: { limitWaitTime: [true], limitType: ['afterTimeInterval'] },
    options: [
      { value: 'minutes', label: 'Minuten' },
      { value: 'hours', label: 'Stunden' },
      { value: 'days', label: 'Tage' },
    ],
  },
  {
    name: 'maxDateAndTime',
    label: 'Spätestens am',
    type: 'dateTime',
    default: '',
    description: 'Datum und Uhrzeit, ab der die Ausführung weiterläuft',
    show: { limitWaitTime: [true], limitType: ['atSpecifiedTime'] },
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: PAGE,
    children: [
      { ...formTitleParam, required: false },
      formDescriptionParam,
      { name: 'buttonLabel', label: 'Beschriftung des Knopfs', type: 'string', default: 'Submit' },
      formCustomCssParam,
    ],
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: { ...COMPLETION, respondWith: ['text', 'returnBinary', 'redirect'] },
    children: [{ ...formTitleParam, required: false, label: 'Titel der Abschlussseite' }, formCustomCssParam],
  },
];

export const formNode: NodeType = {
  type: FORM_NODE_TYPE,
  displayName: 'n8n Form',
  versions: [1, 2.3],
  parameters,
  outputs: () => 1,
  async execute(ctx) {
    const node = ctx.node;
    const operation = ctx.getParam<string>('operation', 0, 'page');
    const parents = ctx.workflow.getParentNodes(node.name).map((n) => ctx.workflow.getNode(n));
    if (!parents.some((n) => n?.type === FORM_TRIGGER_TYPE)) {
      throw new NodeOperationError(node.name, 'Form Trigger node must be set before this node');
    }
    const children = ctx.workflow.getChildNodes(node.name).map((n) => ctx.workflow.getNode(n));
    if (operation === 'completion' && children.some((n) => n?.type === FORM_NODE_TYPE)) {
      throw new NodeOperationError(node.name, 'Completion has to be the last Form node in the workflow');
    }
    if (!ctx.canWait) {
      throw new NodeOperationError(node.name, 'Formularseiten brauchen den Server (filuflow serve): in der CLI und in Unter-Workflows kann eine Ausführung nicht warten');
    }
    // configureWaitTillDate: unbegrenzt oder limitWaitTime
    let waitTill = WAIT_INDEFINITELY;
    if (ctx.getParam<boolean>('limitWaitTime', 0, false) === true) {
      if (ctx.getParam<string>('limitType', 0, 'afterTimeInterval') === 'afterTimeInterval') {
        const amount = ctx.getParam<number>('resumeAmount', 0, 1);
        waitTill = new Date(Date.now() + amount * (UNIT_SECONDS[ctx.getParam<string>('resumeUnit', 0, 'hours')] ?? 1) * 1000);
      } else {
        waitTill = new Date(ctx.getParam<string>('maxDateAndTime', 0, ''));
      }
    }
    ctx.putExecutionToWait(waitTill);
    ctx.sendWebhookResponse({ statusCode: 307, headers: { location: String(ctx.evaluateExpression('{{ $execution.resumeFormUrl }}', 0)) }, body: '' });
    return [ctx.items];
  },
};

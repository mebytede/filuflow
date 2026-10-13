// Wait, n8n-nodes-base.wait (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Wait/Wait.node.ts (execute, configureAndPutToWait, putToWait)
// und packages/cli/src/webhooks/waiting-webhooks.ts (Fortsetzen per Webhook).
// - timeInterval / specificTime: unter 65 s wartet der Prozess, sonst geht die Execution in den Zustand "waiting"
//   und der Server setzt sie zum Zeitpunkt fort (auch nach einem Neustart).
// - webhook: Execution wartet, bis $execution.resumeUrl (/webhook-waiting/<id>[/<webhookSuffix>]) aufgerufen wird;
//   optional begrenzt (limitWaitTime). Der Request wird wie beim Webhook-Node ausgewertet (incomingAuthentication).
// - form: Execution wartet auf das Formular unter $execution.resumeFormUrl (/form-waiting/<id>); nach einem Form
//   Trigger leitet der Knoten den Browser per 307 dorthin (Seiten: src/server/webhooks.ts, src/nodes/shared/form.ts).
// Ohne Server (CLI, Unter-Workflows) kann eine Execution nicht warten: Zeiten werden im Prozess abgewartet,
// "webhook" meldet einen Fehler.
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { tryToParseDateTime } from './shared/utils.js';
import { WAIT_INDEFINITELY } from '../engine/executor.js';
import { FORM_TRIGGER_TYPE } from './shared/form.js';
import type { ParamSchema } from './params.js';

export const WAIT_NODE_TYPE = 'n8n-nodes-base.wait';

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

function sleepInProcess(ctx: ExecContext, ms: number): Promise<Item[][]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve([ctx.items]), ms);
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('The execution was canceled'));
      },
      { once: true },
    );
  });
}

/** configureAndPutToWait: unbegrenzt oder bis limitWaitTime */
function webhookWaitTill(ctx: ExecContext): Date {
  if (ctx.getParam<boolean>('limitWaitTime', 0, false) !== true) return WAIT_INDEFINITELY;
  const limitType = ctx.getParam<string>('limitType', 0, 'afterTimeInterval');
  if (limitType === 'afterTimeInterval') {
    const amount = ctx.getParam<number>('resumeAmount', 0, 1);
    const unit = ctx.getParam<string>('resumeUnit', 0, 'hours');
    return new Date(Date.now() + amount * (UNIT_SECONDS[unit] ?? 1) * 1000);
  }
  return new Date(ctx.getParam<string>('maxDateAndTime', 0, ''));
}

// Parameter wie packages/nodes-base/nodes/Wait/Wait.node.ts, dazu die dort eingebundenen Beschreibungen aus
// packages/nodes-base/nodes/Webhook/description.ts (authenticationProperty, httpMethodsProperty, responseCodeProperty,
// responseModeProperty, responseDataProperty, responseBinaryPropertyNameProperty, optionsProperty) und
// packages/nodes-base/nodes/Form/common.descriptions.ts (formTitle, formDescription, formFields, formRespondMode,
// respondWithOptions, appendAttributionToForm). Die "@version"-Bedingungen aus den eingebundenen Beschreibungen
// beziehen sich wie in n8n auf die Version des Wait-Knotens.

const ON_WEBHOOK = { resume: ['webhook'] };
const ON_FORM = { resume: ['form'] };
const WEBHOOK_OR_FORM = { resume: ['webhook', 'form'] };

const UNIT_OPTIONS = [
  { value: 'seconds', label: 'Sekunden' },
  { value: 'minutes', label: 'Minuten' },
  { value: 'hours', label: 'Stunden' },
  { value: 'days', label: 'Tage' },
];

const waitAmount = (defaultValue: number, rule: Pick<ParamSchema, 'show' | 'hide'>): ParamSchema => ({
  name: 'amount',
  label: 'Wartezeit',
  type: 'number',
  default: defaultValue,
  min: 0,
  precision: 2,
  description: 'Wie lange gewartet wird',
  ...rule,
});

const waitUnit = (defaultValue: string, rule: Pick<ParamSchema, 'show' | 'hide'>): ParamSchema => ({
  name: 'unit',
  label: 'Einheit',
  type: 'options',
  default: defaultValue,
  options: UNIT_OPTIONS,
  description: 'Einheit der Wartezeit',
  ...rule,
});

const webhookSuffix: ParamSchema = {
  name: 'webhookSuffix',
  label: 'Webhook-Suffix',
  type: 'string',
  default: '',
  placeholder: 'webhook',
  noExpression: true,
  description: 'Wird an die URL zum Fortsetzen angehängt; hilfreich bei mehreren Wait-Knoten',
};

const appendAttribution: ParamSchema = {
  name: 'appendAttribution',
  label: 'n8n-Hinweis anhängen',
  type: 'boolean',
  default: true,
  description: 'Ob unten im Formular der Link "Form automated with n8n" erscheint',
};

const fieldOptionsParam = (label: string, addLabel: string, optionLabel: string, fieldType: string, description?: string): ParamSchema => ({
  name: 'fieldOptions',
  label,
  type: 'fixedCollection',
  multiple: true,
  addLabel,
  default: { values: [{ option: '' }] },
  required: true,
  ...(description ? { description } : {}),
  show: { fieldType: [fieldType] },
  groups: [{ name: 'values', label: 'Werte', children: [{ name: 'option', label: optionLabel, type: 'string', default: '' }] }],
});

const formFields: ParamSchema = {
  name: 'formFields',
  label: 'Formularelemente',
  type: 'fixedCollection',
  multiple: true,
  addLabel: 'Formularelement hinzufügen',
  default: {},
  show: ON_FORM,
  groups: [
    {
      name: 'values',
      label: 'Werte',
      children: [
        {
          name: 'fieldLabel',
          label: 'Feldname',
          type: 'string',
          default: '',
          placeholder: 'z. B. Wie heißen Sie?',
          description: 'Beschriftung über dem Eingabefeld',
          required: true,
          hide: { fieldType: ['hiddenField', 'html'] },
        },
        {
          name: 'fieldName',
          label: 'Feldname',
          type: 'string',
          default: '',
          description: 'Name des Felds, wie er im Formular und im Workflow verwendet wird',
          show: { fieldType: ['hiddenField'] },
        },
        {
          name: 'fieldType',
          label: 'Elementtyp',
          type: 'options',
          default: 'text',
          description: 'Art des Formularelements',
          required: true,
          options: [
            { value: 'checkbox', label: 'Checkboxen' },
            { value: 'html', label: 'Eigenes HTML' },
            { value: 'date', label: 'Datum' },
            { value: 'dropdown', label: 'Auswahlliste' },
            { value: 'email', label: 'E-Mail' },
            { value: 'file', label: 'Datei' },
            { value: 'hiddenField', label: 'Verstecktes Feld' },
            { value: 'number', label: 'Zahl' },
            { value: 'password', label: 'Passwort' },
            { value: 'radio', label: 'Radiobuttons' },
            { value: 'text', label: 'Text' },
            { value: 'textarea', label: 'Mehrzeiliger Text' },
          ],
        },
        {
          name: 'elementName',
          label: 'Elementname',
          type: 'string',
          default: '',
          placeholder: 'z. B. content-section',
          description: 'Optional; damit erscheint das HTML in der Ausgabe',
          show: { fieldType: ['html'] },
        },
        {
          name: 'placeholder',
          label: 'Platzhalter',
          type: 'string',
          default: '',
          description: 'Beispieltext im leeren Feld',
          hide: { fieldType: ['dropdown', 'date', 'file', 'html', 'hiddenField', 'radio', 'checkbox'] },
        },
        {
          name: 'defaultValue',
          label: 'Vorgabewert',
          type: 'string',
          default: '',
          description: 'Wert, mit dem das Feld vorausgefüllt wird',
          show: { fieldType: ['text', 'number', 'email', 'textarea'] },
        },
        {
          name: 'defaultValue',
          label: 'Vorgabewert',
          type: 'dateTime',
          default: '',
          description: 'Vorausgefülltes Datum (Format YYYY-MM-DD)',
          show: { fieldType: ['date'] },
        },
        {
          name: 'defaultValue',
          label: 'Vorgabewert',
          type: 'string',
          default: '',
          description: 'Vorausgewählte Option; muss einer Beschriftung entsprechen',
          show: { fieldType: ['dropdown', 'radio'] },
        },
        {
          name: 'defaultValue',
          label: 'Vorgabewert',
          type: 'string',
          default: '',
          description: 'Vorausgewählte Optionen, durch Komma getrennt; müssen Beschriftungen entsprechen',
          show: { fieldType: ['checkbox'] },
        },
        {
          name: 'fieldValue',
          label: 'Feldwert',
          type: 'string',
          default: '',
          description: 'Wert des Felds; ohne Wert wird er als Query-Parameter mit dem Feldnamen übergeben',
          show: { fieldType: ['hiddenField'] },
        },
        fieldOptionsParam('Optionen', 'Option hinzufügen', 'Option', 'dropdown', 'Auswählbare Optionen der Liste'),
        fieldOptionsParam('Checkboxen', 'Checkbox hinzufügen', 'Beschriftung', 'checkbox'),
        fieldOptionsParam('Radiobuttons', 'Radiobutton hinzufügen', 'Beschriftung', 'radio'),
        {
          name: 'multiselectLegacyNotice',
          label: 'Mehrfachauswahl ist veraltet, bitte verwenden Sie Checkboxen oder Radiobuttons.',
          type: 'notice',
          default: '',
          show: { multiselect: [true], fieldType: ['dropdown'], '@version': [{ _cnd: { lt: 2.3 } }] },
        },
        {
          name: 'multiselect',
          label: 'Mehrfachauswahl',
          type: 'boolean',
          default: false,
          description: 'Ob mehrere Optionen der Liste gewählt werden können',
          show: { fieldType: ['dropdown'], '@version': [{ _cnd: { lt: 2.3 } }] },
        },
        {
          name: 'limitSelection',
          label: 'Auswahl begrenzen',
          type: 'options',
          default: 'unlimited',
          options: [
            { value: 'exact', label: 'Genaue Anzahl' },
            { value: 'range', label: 'Bereich' },
            { value: 'unlimited', label: 'Unbegrenzt' },
          ],
          show: { fieldType: ['checkbox'] },
        },
        {
          name: 'numberOfSelections',
          label: 'Anzahl Auswahlen',
          type: 'number',
          default: 1,
          precision: 0,
          min: 1,
          show: { fieldType: ['checkbox'], limitSelection: ['exact'] },
        },
        {
          name: 'minSelections',
          label: 'Mindestens',
          type: 'number',
          default: 0,
          precision: 0,
          min: 0,
          show: { fieldType: ['checkbox'], limitSelection: ['range'] },
        },
        {
          name: 'maxSelections',
          label: 'Höchstens',
          type: 'number',
          default: 1,
          precision: 0,
          min: 1,
          show: { fieldType: ['checkbox'], limitSelection: ['range'] },
        },
        {
          name: 'html',
          label: 'HTML',
          type: 'code',
          language: 'html',
          noExpression: true,
          default: '<!-- Your custom HTML here --->\n\n\n',
          description: 'HTML-Elemente auf der Formularseite (ohne script, style und input)',
          show: { fieldType: ['html'] },
        },
        {
          name: 'multipleFiles',
          label: 'Mehrere Dateien',
          type: 'boolean',
          default: true,
          description: 'Ob mehrere Dateien gewählt werden können',
          show: { fieldType: ['file'] },
        },
        {
          name: 'acceptFileTypes',
          label: 'Erlaubte Dateitypen',
          type: 'string',
          default: '',
          placeholder: 'z. B. .jpg, .png',
          description: 'Dateiendungen, durch Komma getrennt; leer erlaubt alle',
          show: { fieldType: ['file'] },
        },
        {
          name: 'formatDate',
          label: 'Das Datum wird im Format der Spracheinstellung des Browsers angezeigt.',
          type: 'notice',
          default: '',
          show: { fieldType: ['date'] },
        },
        {
          name: 'requiredField',
          label: 'Pflichtfeld',
          type: 'boolean',
          default: false,
          description: 'Ob das Feld vor dem Absenden ausgefüllt werden muss',
          hide: { fieldType: ['html', 'hiddenField'] },
        },
      ],
    },
  ],
};

const respondWithOptions: ParamSchema = {
  name: 'respondWithOptions',
  label: 'Antwort des Formulars',
  type: 'fixedCollection',
  addLabel: 'Option hinzufügen',
  default: { values: { respondWith: 'text' } },
  groups: [
    {
      name: 'values',
      label: 'Werte',
      children: [
        {
          name: 'respondWith',
          label: 'Antworten mit',
          type: 'options',
          default: 'text',
          options: [
            { value: 'text', label: 'Text nach dem Absenden', description: 'Einen Text anzeigen' },
            { value: 'redirect', label: 'Weiterleitung', description: 'Auf eine URL weiterleiten' },
          ],
        },
        {
          name: 'formSubmittedText',
          label: 'Angezeigter Text',
          type: 'string',
          default: 'Your response has been recorded',
          description: 'Text nach dem Absenden; leer für keinen Text',
          show: { respondWith: ['text'] },
        },
        {
          name: 'redirectUrl',
          label: 'Weiterleiten an URL',
          type: 'string',
          default: '',
          placeholder: 'z. B. http://www.n8n.io',
          description: 'URL, auf die nach dem Absenden weitergeleitet wird',
          show: { respondWith: ['redirect'] },
        },
      ],
    },
  ],
};

const parameters: ParamSchema[] = [
  {
    name: 'resume',
    label: 'Fortsetzen',
    type: 'options',
    default: 'timeInterval',
    options: [
      { value: 'timeInterval', label: 'Nach einer Zeitspanne', description: 'Eine bestimmte Zeit warten' },
      { value: 'specificTime', label: 'Zu einem Zeitpunkt', description: 'Bis zu einem bestimmten Datum und einer Uhrzeit warten' },
      { value: 'webhook', label: 'Bei Webhook-Aufruf', description: 'Auf einen Webhook-Aufruf warten' },
      { value: 'form', label: 'Nach Absenden eines Formulars', description: 'Auf das Absenden eines Formulars warten' },
    ],
    description: 'Wann der Workflow weiterläuft',
  },
  {
    name: 'incomingAuthentication',
    label: 'Authentifizierung',
    type: 'options',
    default: 'none',
    options: [
      { value: 'basicAuth', label: 'Basic Auth' },
      { value: 'none', label: 'Keine' },
    ],
    description: 'Ob und wie Aufrufe von $execution.resumeFormUrl authentifiziert werden',
    show: ON_FORM,
  },
  {
    name: 'incomingAuthentication',
    label: 'Authentifizierung',
    type: 'options',
    default: 'none',
    options: [
      { value: 'basicAuth', label: 'Basic Auth' },
      { value: 'headerAuth', label: 'Header Auth' },
      { value: 'jwtAuth', label: 'JWT Auth' },
      { value: 'none', label: 'Keine' },
    ],
    description: 'Ob und wie Aufrufe von $execution.resumeUrl authentifiziert werden',
    show: ON_WEBHOOK,
  },
  // resume: specificTime
  {
    name: 'dateTime',
    label: 'Datum und Uhrzeit',
    type: 'dateTime',
    default: '',
    required: true,
    description: 'Bis zu diesem Zeitpunkt wird gewartet',
    show: { resume: ['specificTime'] },
  },
  // resume: timeInterval
  waitAmount(1, { show: { resume: ['timeInterval'], '@version': [1] } }),
  waitAmount(5, { show: { resume: ['timeInterval'] }, hide: { '@version': [1] } }),
  waitUnit('hours', { show: { resume: ['timeInterval'], '@version': [1] } }),
  waitUnit('seconds', { show: { resume: ['timeInterval'] }, hide: { '@version': [1] } }),
  // resume: webhook, form
  {
    name: 'webhookNotice',
    label: 'Die Webhook-URL entsteht erst bei der Ausführung und steht in $execution.resumeUrl. Senden Sie sie vor diesem Knoten an die Gegenstelle.',
    type: 'notice',
    default: '',
    show: ON_WEBHOOK,
  },
  {
    name: 'formNotice',
    label: 'Die Formular-URL entsteht erst bei der Ausführung und steht in $execution.resumeFormUrl. Senden Sie sie vor diesem Knoten an die Empfänger.',
    type: 'notice',
    default: '',
    show: ON_FORM,
  },
  // Form/common.descriptions.ts
  {
    name: 'formTitle',
    label: 'Titel des Formulars',
    type: 'string',
    default: '',
    placeholder: 'z. B. Kontakt',
    required: true,
    description: 'Steht oben im Formular',
    show: ON_FORM,
  },
  {
    name: 'formDescription',
    label: 'Beschreibung des Formulars',
    type: 'string',
    default: '',
    placeholder: 'z. B. Wir melden uns bald bei Ihnen',
    rows: 2,
    description: 'Steht unter dem Titel; HTML ist erlaubt',
    show: ON_FORM,
  },
  formFields,
  {
    name: 'responseMode',
    label: 'Antworten, wenn',
    type: 'options',
    default: 'onReceived',
    options: [
      { value: 'onReceived', label: 'Formular abgeschickt ist', description: 'Sobald dieser Knoten das Formular erhält' },
      { value: 'lastNode', label: 'Workflow fertig ist', description: 'Wenn der letzte Knoten des Workflows ausgeführt ist' },
      { value: 'responseNode', label: "Über den Knoten 'Respond to Webhook'", description: 'Wenn der Knoten Respond to Webhook ausgeführt wird' },
    ],
    description: 'Wann auf das Absenden geantwortet wird',
    show: ON_FORM,
  },
  // Webhook/description.ts
  {
    name: 'httpMethod',
    label: 'HTTP-Methode',
    type: 'options',
    default: 'GET',
    options: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].map((m) => ({ value: m, label: m })),
    description: 'HTTP-Methode des Webhook-Aufrufs',
    show: ON_WEBHOOK,
  },
  {
    name: 'responseCode',
    label: 'Statuscode der Antwort',
    type: 'number',
    default: 200,
    min: 100,
    max: 599,
    description: 'HTTP-Statuscode, der zurückgegeben wird',
    show: ON_WEBHOOK,
    hide: { responseMode: ['responseNode'] },
  },
  {
    name: 'responseMode',
    label: 'Antworten',
    type: 'options',
    default: 'onReceived',
    options: [
      { value: 'onReceived', label: 'Sofort', description: 'Sobald dieser Knoten ausgeführt wird' },
      { value: 'lastNode', label: 'Wenn der letzte Knoten fertig ist', description: 'Gibt die Daten des zuletzt ausgeführten Knotens zurück' },
      { value: 'responseNode', label: "Über den Knoten 'Respond to Webhook'", description: 'Die Antwort legt dieser Knoten fest' },
    ],
    description: 'Wann und wie auf den Webhook geantwortet wird',
    show: { '@version': [1, 1.1, 2], ...ON_WEBHOOK },
  },
  {
    name: 'responseData',
    label: 'Daten der Antwort',
    type: 'options',
    default: 'firstEntryJson',
    options: [
      { value: 'allEntries', label: 'Alle Einträge', description: 'Alle Einträge des letzten Knotens, immer als Array' },
      { value: 'firstEntryJson', label: 'JSON des ersten Eintrags', description: 'JSON des ersten Eintrags, immer als Objekt' },
      { value: 'firstEntryBinary', label: 'Binärdaten des ersten Eintrags', description: 'Binärdaten des ersten Eintrags, immer als Datei' },
      { value: 'noData', label: 'Ohne Body', description: 'Antwort ohne Body' },
    ],
    description: 'Welche Daten zurückgegeben werden',
    show: { responseMode: ['lastNode'], ...ON_WEBHOOK },
  },
  {
    name: 'responseBinaryPropertyName',
    label: 'Feldname',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Name des Binärfelds, das zurückgegeben wird',
    show: { responseData: ['firstEntryBinary'], ...ON_WEBHOOK },
  },
  // waitTimeProperties
  {
    name: 'limitWaitTime',
    label: 'Wartezeit begrenzen',
    type: 'boolean',
    default: false,
    description: 'Ob die Ausführung nach einer Höchstzeit auch ohne Antwort weiterläuft',
    show: WEBHOOK_OR_FORM,
  },
  {
    name: 'limitType',
    label: 'Art der Begrenzung',
    type: 'options',
    default: 'afterTimeInterval',
    options: [
      { value: 'afterTimeInterval', label: 'Nach einer Zeitspanne', description: 'Eine bestimmte Zeit warten' },
      { value: 'atSpecifiedTime', label: 'Zu einem Zeitpunkt', description: 'Bis zu einem bestimmten Datum und einer Uhrzeit warten' },
    ],
    description: 'Wann die Ausführung spätestens weiterläuft',
    show: { limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'resumeAmount',
    label: 'Dauer',
    type: 'number',
    default: 1,
    min: 0,
    precision: 2,
    description: 'Wie lange höchstens gewartet wird',
    show: { limitType: ['afterTimeInterval'], limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'resumeUnit',
    label: 'Einheit',
    type: 'options',
    default: 'hours',
    options: UNIT_OPTIONS,
    description: 'Einheit der Dauer',
    show: { limitType: ['afterTimeInterval'], limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'maxDateAndTime',
    label: 'Spätestens um',
    type: 'dateTime',
    default: '',
    description: 'Zu diesem Zeitpunkt läuft die Ausführung weiter',
    show: { limitType: ['atSpecifiedTime'], limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  // Optionen bei resume=webhook: optionsProperty aus Webhook/description.ts plus webhookSuffix
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: ON_WEBHOOK,
    children: [
      {
        name: 'binaryData',
        label: 'Binärdatei',
        type: 'boolean',
        default: false,
        description: 'Ob der Webhook Binärdaten empfängt',
        show: { '/httpMethod': ['PATCH', 'PUT', 'POST'], '@version': [1] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Datei in Feld ablegen',
        type: 'string',
        default: 'data',
        description: 'Name des Binärfelds; bei Multipart-Formulardaten Präfix mit angehängter Nummer ab 0',
        show: { binaryData: [true], '@version': [1] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Feld für Binärdaten',
        type: 'string',
        default: 'data',
        description: 'Name des Ausgabefelds für empfangene Binärdaten',
        hide: { '@version': [1] },
      },
      {
        name: 'ignoreBots',
        label: 'Bots ignorieren',
        type: 'boolean',
        default: false,
        description: 'Ob Anfragen von Bots wie Link-Vorschauen und Crawlern ignoriert werden',
      },
      {
        name: 'ipWhitelist',
        label: 'Erlaubte IP-Adressen',
        type: 'string',
        default: '',
        placeholder: 'z. B. 127.0.0.1',
        description: 'IP-Adressen, durch Komma getrennt; leer erlaubt alle',
      },
      {
        name: 'noResponseBody',
        label: 'Ohne Body antworten',
        type: 'boolean',
        default: false,
        description: 'Ob die Antwort ohne Body gesendet wird',
        show: { '/responseMode': ['onReceived'] },
        hide: { rawBody: [true] },
      },
      {
        name: 'rawBody',
        label: 'Roher Body',
        type: 'boolean',
        default: false,
        description: 'Body als Binärdaten übernehmen',
        show: { '@version': [1] },
        hide: { binaryData: [true], noResponseBody: [true] },
      },
      {
        name: 'rawBody',
        label: 'Roher Body',
        type: 'boolean',
        default: false,
        description: 'Ob der rohe Body übernommen wird',
        hide: { noResponseBody: [true], '@version': [1] },
      },
      {
        name: 'responseData',
        label: 'Daten der Antwort',
        type: 'string',
        default: '',
        placeholder: 'success',
        description: 'Eigene Daten, die als Antwort gesendet werden',
        show: { '/responseMode': ['onReceived'] },
        hide: { noResponseBody: [true] },
      },
      {
        name: 'responseContentType',
        label: 'Content-Type der Antwort',
        type: 'string',
        default: '',
        placeholder: 'application/xml',
        description: 'Eigener Content-Type statt application/json',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      {
        name: 'responseHeaders',
        label: 'Header der Antwort',
        type: 'fixedCollection',
        multiple: true,
        addLabel: 'Header hinzufügen',
        default: {},
        description: 'Header, die der Antwort hinzugefügt werden',
        groups: [
          {
            name: 'entries',
            label: 'Einträge',
            children: [
              { name: 'name', label: 'Name', type: 'string', default: '', description: 'Name des Headers' },
              { name: 'value', label: 'Wert', type: 'string', default: '', description: 'Wert des Headers' },
            ],
          },
        ],
      },
      {
        name: 'responsePropertyName',
        label: 'Feldname',
        type: 'string',
        default: 'data',
        description: 'Nur dieses Feld statt des ganzen JSON zurückgeben',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      webhookSuffix,
    ],
  },
  // Optionen bei resume=form
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: ON_FORM,
    hide: { responseMode: ['responseNode'] },
    children: [appendAttribution, respondWithOptions, webhookSuffix],
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: ON_FORM,
    hide: { responseMode: ['onReceived', 'lastNode'] },
    children: [appendAttribution, webhookSuffix],
  },
];

export const waitNode: NodeType = {
  type: WAIT_NODE_TYPE,
  displayName: 'Wait',
  versions: [1, 1.1],
  parameters,
  outputs: () => 1,
  credentialTypes(node) {
    const resume = node.parameters.resume ?? 'timeInterval';
    if (resume !== 'webhook' && resume !== 'form') return [];
    const map: Record<string, string> = { basicAuth: 'httpBasicAuth', headerAuth: 'httpHeaderAuth', jwtAuth: 'jwtAuth' };
    const t = map[String(node.parameters.incomingAuthentication ?? 'none')];
    return t ? [t] : [];
  },
  validate(node) {
    const issues: NodeIssue[] = [];
    const resume = (node.parameters.resume as string | undefined) ?? 'timeInterval';
    if (resume === 'webhook' && node.parameters.responseMode === 'streaming') {
      issues.push({ code: 'webhook.streaming', message: 'responseMode "streaming" wird nicht unterstützt', path: 'parameters.responseMode' });
    }
    return issues;
  },
  async execute(ctx) {
    const node = ctx.node;
    const resume = ctx.getParam<string>('resume', 0, 'timeInterval');
    if (resume === 'webhook' || resume === 'form') {
      if (!ctx.canWait) {
        throw new NodeOperationError(
          node.name,
          `Wait "${resume === 'form' ? 'On Form Submitted' : 'On Webhook Call'}" braucht den Server (filuflow serve): in der CLI und in Unter-Workflows kann eine Ausführung nicht warten`,
        );
      }
      ctx.putExecutionToWait(webhookWaitTill(ctx));
      // Nach einem Form Trigger: Browser auf das Formular dieses Knotens leiten
      if (resume === 'form' && ctx.workflow.getParentNodes(node.name).some((n) => ctx.workflow.getNode(n)?.type === FORM_TRIGGER_TYPE)) {
        ctx.sendWebhookResponse({ statusCode: 307, headers: { location: String(ctx.evaluateExpression('{{ $execution.resumeFormUrl }}', 0)) }, body: '' });
      }
      return [ctx.items];
    }

    let waitTill: Date;
    if (resume === 'timeInterval') {
      const v1 = node.typeVersion === 1;
      const unit = ctx.getParam<unknown>('unit', 0, v1 ? 'hours' : 'seconds');
      if (typeof unit !== 'string' || !(unit in UNIT_SECONDS)) {
        throw new NodeOperationError(node.name, "Invalid wait unit. Valid units are 'seconds', 'minutes', 'hours', or 'days'.");
      }
      const amount = ctx.getParam<unknown>('amount', 0, v1 ? 1 : 5);
      if (typeof amount !== 'number' || amount < 0) {
        throw new NodeOperationError(node.name, 'Invalid wait amount. Please enter a number that is 0 or greater.');
      }
      waitTill = new Date(Date.now() + amount * UNIT_SECONDS[unit] * 1000);
    } else {
      try {
        waitTill = tryToParseDateTime(ctx.getParam('dateTime', 0, ''), ctx.timezone).toUTC().toJSDate();
      } catch {
        throw new NodeOperationError(
          node.name,
          'Cannot put execution to wait because `dateTime` parameter is not a valid date. Please pick a specific date and time to wait until.',
        );
      }
    }
    const ms = Math.max(waitTill.getTime() - Date.now(), 0);
    // n8n: unter 65 s im Prozess warten (die Datenbank wird nur alle 60 s geprüft)
    if (ms < 65_000 || !ctx.canWait) return sleepInProcess(ctx, ms);
    ctx.putExecutionToWait(waitTill);
    return [ctx.items];
  },
};

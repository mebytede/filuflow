// Gemeinsame Parameterbeschreibungen der Formular-Knoten (Form Trigger, Form) für die Editor-Formulare.
// Nach n8n 1.123.0 packages/nodes-base/nodes/Form/common.descriptions.ts (webhookPath, formTitle, formDescription,
// formFields, formRespondMode, respondWithOptions, appendAttributionToForm) und Form.node.ts (formFieldsProperties).
import type { ParamSchema } from '../params.js';

/** Form Path (webhookPath) */
export const formPathParam: ParamSchema = {
  name: 'path',
  label: 'Formular-Pfad',
  type: 'string',
  default: '',
  placeholder: 'webhook',
  required: true,
  description: 'Letzter Teil der Formular-URL, für Test und Produktion',
};

/** Form Title (formTitle) */
export const formTitleParam: ParamSchema = {
  name: 'formTitle',
  label: 'Formulartitel',
  type: 'string',
  default: '',
  placeholder: 'z. B. Kontakt',
  required: true,
  description: 'Steht oben im Formular',
};

/** Form Description (formDescription) */
export const formDescriptionParam: ParamSchema = {
  name: 'formDescription',
  label: 'Formularbeschreibung',
  type: 'string',
  default: '',
  placeholder: 'z. B. Wir melden uns bald',
  rows: 2,
  description: 'Steht unter dem Titel und darf HTML enthalten',
};

// common.descriptions.ts placeholder (Default des HTML-Felds)
const HTML_PLACEHOLDER = '<!-- Your custom HTML here --->\n\n\n';

/** Eine Liste mit Einträgen { option } (fieldOptions), je Feldtyp mit eigener Beschriftung */
function fieldOptionsParam(fieldType: string, label: string, entryLabel: string, addLabel: string, description?: string): ParamSchema {
  return {
    name: 'fieldOptions',
    label,
    type: 'fixedCollection',
    default: { values: [{ option: '' }] },
    required: true,
    multiple: true,
    addLabel,
    ...(description ? { description } : {}),
    show: { fieldType: [fieldType] },
    groups: [{ name: 'values', label: 'Werte', children: [{ name: 'option', label: entryLabel, type: 'string', default: '' }] }],
  };
}

/** Form Elements (formFields): Felder des Formulars */
export const formFieldsParam: ParamSchema = {
  name: 'formFields',
  label: 'Formularelemente',
  type: 'fixedCollection',
  default: {},
  multiple: true,
  addLabel: 'Formularelement hinzufügen',
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
          required: true,
          description: 'Beschriftung über dem Eingabefeld',
          hide: { fieldType: ['hiddenField', 'html'] },
        },
        {
          name: 'fieldName',
          label: 'Feldname',
          type: 'string',
          default: '',
          description: 'Name des Felds in den Eingabeattributen und im Workflow',
          show: { fieldType: ['hiddenField'] },
        },
        {
          name: 'fieldType',
          label: 'Elementtyp',
          type: 'options',
          default: 'text',
          required: true,
          description: 'Art des Formularfelds',
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
          label: 'Standardwert',
          type: 'string',
          default: '',
          description: 'Wert, mit dem das Feld vorbelegt ist',
          show: { fieldType: ['text', 'number', 'email', 'textarea'] },
        },
        {
          name: 'defaultValue',
          label: 'Standardwert',
          type: 'dateTime',
          default: '',
          description: 'Vorbelegtes Datum im Format JJJJ-MM-TT',
          show: { fieldType: ['date'] },
        },
        {
          name: 'defaultValue',
          label: 'Standardwert',
          type: 'string',
          default: '',
          description: 'Vorausgewählte Option; muss einer Beschriftung entsprechen',
          show: { fieldType: ['dropdown', 'radio'] },
        },
        {
          name: 'defaultValue',
          label: 'Standardwert',
          type: 'string',
          default: '',
          description: 'Vorausgewählte Optionen, mehrere durch Komma getrennt',
          show: { fieldType: ['checkbox'] },
        },
        {
          name: 'fieldValue',
          label: 'Feldwert',
          type: 'string',
          default: '',
          description: 'Ohne Wert kommt er als Query-Parameter mit dem Feldnamen',
          show: { fieldType: ['hiddenField'] },
        },
        fieldOptionsParam('dropdown', 'Feldoptionen', 'Option', 'Option hinzufügen', 'Optionen der Auswahlliste'),
        fieldOptionsParam('checkbox', 'Checkboxen', 'Beschriftung', 'Checkbox hinzufügen'),
        fieldOptionsParam('radio', 'Radiobuttons', 'Beschriftung', 'Radiobutton hinzufügen'),
        {
          name: 'multiselectLegacyNotice',
          label: 'Mehrfachauswahl ist veraltet; besser Checkboxen oder Radiobuttons verwenden.',
          type: 'notice',
          default: '',
          show: { multiselect: [true], fieldType: ['dropdown'], '@version': [{ _cnd: { lt: 2.3 } }] },
        },
        {
          name: 'multiselect',
          label: 'Mehrfachauswahl',
          type: 'boolean',
          default: false,
          description: 'Ob mehrere Optionen gewählt werden dürfen',
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
          label: 'Mindestens Auswahlen',
          type: 'number',
          default: 0,
          precision: 0,
          min: 0,
          show: { fieldType: ['checkbox'], limitSelection: ['range'] },
        },
        {
          name: 'maxSelections',
          label: 'Höchstens Auswahlen',
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
          default: HTML_PLACEHOLDER,
          noExpression: true,
          description: 'HTML auf der Formularseite, ohne script-, style- und input-Tags',
          show: { fieldType: ['html'] },
        },
        {
          name: 'multipleFiles',
          label: 'Mehrere Dateien',
          type: 'boolean',
          default: true,
          description: 'Ob mehrere Dateien gewählt werden dürfen',
          show: { fieldType: ['file'] },
        },
        {
          name: 'acceptFileTypes',
          label: 'Erlaubte Dateitypen',
          type: 'string',
          default: '',
          placeholder: 'z. B. .jpg, .png',
          description: 'Dateiendungen durch Komma getrennt; leer erlaubt alle',
          show: { fieldType: ['file'] },
        },
        {
          name: 'formatDate',
          label: 'Das Datum wird im Format der Browser-Sprache angezeigt.',
          type: 'notice',
          default: '',
          show: { fieldType: ['date'] },
        },
        {
          name: 'requiredField',
          label: 'Pflichtfeld',
          type: 'boolean',
          default: false,
          description: 'Ob das Feld vor dem Absenden ausgefüllt sein muss',
          hide: { fieldType: ['html', 'hiddenField'] },
        },
      ],
    },
  ],
};

/** Respond When (formRespondMode); `withResponseNode: false` wie Form Trigger ab v2.2 */
export function formRespondModeParam(withResponseNode: boolean): ParamSchema {
  return {
    name: 'responseMode',
    label: 'Antworten, wenn',
    type: 'options',
    default: 'onReceived',
    description: 'Wann auf das Absenden geantwortet wird',
    options: [
      { value: 'onReceived', label: 'Formular abgeschickt', description: 'Sobald dieser Knoten die Eingaben erhält' },
      { value: 'lastNode', label: 'Workflow beendet', description: 'Wenn der letzte Knoten ausgeführt ist' },
      ...(withResponseNode
        ? [{ value: 'responseNode', label: "Über Knoten 'Respond to Webhook'", description: "Wenn der Knoten 'Respond to Webhook' läuft" }]
        : []),
    ],
  };
}

/** Form Response (respondWithOptions) */
export const respondWithOptionsParam: ParamSchema = {
  name: 'respondWithOptions',
  label: 'Antwort des Formulars',
  type: 'fixedCollection',
  default: { values: { respondWith: 'text' } },
  addLabel: 'Option hinzufügen',
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
            { value: 'text', label: 'Text nach dem Absenden', description: 'Zeigt einen Text an' },
            { value: 'redirect', label: 'Weiterleitung', description: 'Leitet auf eine URL weiter' },
          ],
        },
        {
          name: 'formSubmittedText',
          label: 'Angezeigter Text',
          type: 'string',
          default: 'Your response has been recorded',
          description: 'Text nach dem Absenden; leer zeigt keinen Zusatztext',
          show: { respondWith: ['text'] },
        },
        {
          name: 'redirectUrl',
          label: 'Weiterleitungs-URL',
          type: 'string',
          default: '',
          placeholder: 'z. B. https://example.com',
          description: 'Gültige URL, auf die nach dem Absenden weitergeleitet wird',
          show: { respondWith: ['redirect'] },
        },
      ],
    },
  ],
};

/** Append n8n Attribution (appendAttributionToForm) */
export const appendAttributionParam: ParamSchema = {
  name: 'appendAttribution',
  label: 'n8n-Hinweis anhängen',
  type: 'boolean',
  default: true,
  description: 'Ob unten im Formular der Hinweis „Form automated with n8n“ steht',
};

/**
 * Custom Form Styling (customCss). Abweichung: n8n setzt als Default seine CSS-Variablen (Form/cssVariables.ts).
 * Die filuflow-Seiten nutzen diese Variablen nicht, und die Vorlage wird nicht kopiert; Default ist daher leer.
 */
export const formCustomCssParam: ParamSchema = {
  name: 'customCss',
  label: 'Eigenes Formular-Styling',
  type: 'code',
  language: 'css',
  rows: 10,
  default: '',
  description: 'CSS, das die Gestaltung des öffentlichen Formulars überschreibt',
};

// Form.node.ts formFieldsProperties: Default von jsonOutput (Beispielfelder)
const JSON_FIELDS_DEFAULT = `${JSON.stringify(
  [
    { fieldLabel: 'Name', placeholder: 'enter your name', requiredField: true },
    { fieldLabel: 'Age', fieldType: 'number', placeholder: 'enter your age' },
    { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
    { fieldLabel: 'Textarea', fieldType: 'textarea' },
    { fieldLabel: 'Dropdown Options', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'option 1' }, { option: 'option 2' }] }, requiredField: true },
    { fieldLabel: 'Checkboxes', fieldType: 'checkbox', fieldOptions: { values: [{ option: 'option 1' }, { option: 'option 2' }] } },
    { fieldLabel: 'Radio', fieldType: 'radio', fieldOptions: { values: [{ option: 'option 1' }, { option: 'option 2' }] } },
    { fieldLabel: 'Email', fieldType: 'email', placeholder: 'me@mail.con' },
    { fieldLabel: 'File', fieldType: 'file', multipleFiles: true, acceptFileTypes: '.jpg, .png' },
    { fieldLabel: 'Number', fieldType: 'number' },
    { fieldLabel: 'Password', fieldType: 'password' },
  ],
  null,
  2,
)}\n`;

/** Define Form, jsonOutput und formFields wie Form.node.ts formFieldsProperties */
export const formFieldsDefinitionParams: ParamSchema[] = [
  {
    name: 'defineForm',
    label: 'Formular festlegen',
    type: 'options',
    default: 'fields',
    noExpression: true,
    options: [
      { value: 'fields', label: 'Mit den Feldern unten' },
      { value: 'json', label: 'Mit JSON' },
    ],
  },
  {
    name: 'jsonOutput',
    label: 'Formularfelder',
    type: 'json',
    rows: 5,
    default: JSON_FIELDS_DEFAULT,
    description: 'Felder als JSON-Liste mit denselben Schlüsseln wie die Formularelemente',
    show: { defineForm: ['json'] },
  },
  { ...formFieldsParam, show: { defineForm: ['fields'] } },
];

// Gemeinsame Parameterbeschreibungen der KI-Knoten (Agent, Chains, Structured Output Parser) für die Formulare im Editor.
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/utils/descriptions.ts (promptTypeOptions, textInput,
// textFromPreviousNode, textFromGuardrailsNode, schemaTypeField, buildJsonSchemaExampleField,
// buildJsonSchemaExampleNotice, buildInputSchemaField) und utils/sharedFields.ts (getBatchingOptionFields).
// Hinweisfelder (callout) und Verweise auf n8n-Vorlagen sind nicht übernommen, sie speichern keinen Wert.
import type { DisplayRule, ParamOption, ParamSchema } from '../params.js';

/** promptTypeOptions: Quelle des Prompts (Default "auto") */
export const promptTypeParam: ParamSchema = {
  name: 'promptType',
  label: 'Quelle für Prompt (User Message)',
  type: 'options',
  default: 'auto',
  options: [
    { value: 'auto', label: 'Verbundener Chat Trigger', description: "Nimmt das Feld 'chatInput' vom direkt verbundenen Chat Trigger" },
    {
      value: 'guardrails',
      label: 'Verbundener Guardrails-Knoten',
      description: "Nimmt das Feld 'guardrailsInput' vom direkt verbundenen Guardrails-Knoten",
    },
    { value: 'define', label: 'Unten festlegen', description: 'Expression auf Daten vorheriger Knoten oder fester Text' },
  ],
};

/** textFromGuardrailsNode (in n8n bei promptType "guardrails" gesperrt) */
export const textFromGuardrailsParam: ParamSchema = {
  name: 'text',
  label: 'Prompt (User Message)',
  type: 'string',
  required: true,
  default: '={{ $json.guardrailsInput }}',
  rows: 2,
  description: 'Kommt aus dem Feld guardrailsInput des verbundenen Guardrails-Knotens',
};

/** textFromPreviousNode (in n8n bei promptType "auto" gesperrt) */
export const textFromPreviousNodeParam: ParamSchema = {
  name: 'text',
  label: 'Prompt (User Message)',
  type: 'string',
  required: true,
  default: '={{ $json.chatInput }}',
  rows: 2,
  description: 'Kommt aus dem Feld chatInput des verbundenen Chat Triggers',
};

/** textInput: Prompt frei festlegen */
export const textInputParam: ParamSchema = {
  name: 'text',
  label: 'Prompt (User Message)',
  type: 'string',
  required: true,
  default: '',
  placeholder: 'z. B. Hallo, wobei kannst du mir helfen?',
  rows: 2,
};

/** Hinweis bei hasOutputParser = true (Agent V2/V3, ChainLlm) */
export const outputParserNoticeParam: ParamSchema = {
  name: 'notice',
  label: 'Einen Output Parser im Canvas verbinden, um das gewünschte Ausgabeformat festzulegen',
  type: 'notice',
  default: '',
  show: { hasOutputParser: [true] },
};

/** Hinweis bei needsFallback = true (Agent V2/V3, ChainLlm) */
export const fallbackNoticeParam: ParamSchema = {
  name: 'fallbackNotice',
  label: 'Ein weiteres Sprachmodell im Canvas verbinden, es springt ein, wenn das Hauptmodell fehlschlägt',
  type: 'notice',
  default: '',
  show: { needsFallback: [true] },
};

/** getBatchingOptionFields(displayOptions, defaultBatchSize) */
export function batchingParam(show: DisplayRule | undefined, defaultBatchSize = 5): ParamSchema {
  return {
    name: 'batching',
    label: 'Stapelverarbeitung',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    description: 'Optionen zur Begrenzung der Anfragerate',
    ...(show ? { show } : {}),
    children: [
      {
        name: 'batchSize',
        label: 'Stapelgröße',
        type: 'number',
        default: defaultBatchSize,
        description: 'Wie viele Items parallel verarbeitet werden',
      },
      {
        name: 'delayBetweenBatches',
        label: 'Pause zwischen Stapeln',
        type: 'number',
        default: 0,
        description: 'Pause zwischen den Stapeln in Millisekunden',
      },
    ],
  };
}

/** Optionen von schemaTypeField */
export const schemaTypeOptions: ParamOption[] = [
  { value: 'fromJson', label: 'Aus JSON-Beispiel erzeugen', description: 'Schema aus einem JSON-Beispielobjekt erzeugen' },
  { value: 'manual', label: 'Mit JSON Schema festlegen', description: 'JSON Schema von Hand festlegen' },
];

/** schemaTypeField (Default "fromJson") */
export const schemaTypeParam: ParamSchema = {
  name: 'schemaType',
  label: 'Art des Schemas',
  type: 'options',
  noExpression: true,
  default: 'fromJson',
  options: schemaTypeOptions,
  description: 'Wie das Schema angegeben wird',
};

/** Beispiel aus OutputParserStructured und InformationExtractor (überschreibt den Default von jsonSchemaExampleField) */
export const STATE_CITIES_EXAMPLE = `{
\t"state": "California",
\t"cities": ["Los Angeles", "San Francisco", "San Diego"]
}`;

/** Schema aus OutputParserStructured und InformationExtractor (überschreibt den Default von inputSchemaField) */
export const STATE_CITIES_INPUT_SCHEMA = `{
\t"type": "object",
\t"properties": {
\t\t"state": {
\t\t\t"type": "string"
\t\t},
\t\t"cities": {
\t\t\t"type": "array",
\t\t\t"items": {
\t\t\t\t"type": "string"
\t\t\t}
\t\t}
\t}
}`;

/** buildJsonSchemaExampleField mit dem Default des Knotens */
export function jsonSchemaExampleParam(defaultValue: string): ParamSchema {
  return {
    name: 'jsonSchemaExample',
    label: 'JSON-Beispiel',
    type: 'json',
    default: defaultValue,
    noExpression: true,
    rows: 10,
    show: { schemaType: ['fromJson'] },
    description: 'JSON-Beispielobjekt, aus dem das Schema erzeugt wird',
  };
}

/** buildJsonSchemaExampleNotice({ showExtraProps }) */
export function jsonSchemaExampleNoticeParam(showExtra: DisplayRule): ParamSchema {
  return {
    name: 'notice',
    label: "Alle Eigenschaften sind Pflicht. Für optionale Eigenschaften die Art 'JSON Schema' wählen",
    type: 'notice',
    default: '',
    show: { ...showExtra, schemaType: ['fromJson'] },
  };
}

/** buildInputSchemaField mit dem Default des Knotens (Expressions erlaubt) */
export function inputSchemaParam(defaultValue: string): ParamSchema {
  return {
    name: 'inputSchema',
    label: 'Input Schema',
    type: 'json',
    default: defaultValue,
    rows: 10,
    show: { schemaType: ['manual'] },
    description: 'Schema im Format JSON Schema, $ref wird nicht unterstützt',
  };
}

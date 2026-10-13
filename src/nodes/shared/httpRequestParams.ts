// Parameter des HTTP Request (n8n-nodes-base.httpRequest, typeVersion 3, 4, 4.1, 4.2, 4.3) für das Formular im Editor.
// Nachgebaut nach n8n 1.123.0:
//   packages/nodes-base/nodes/HttpRequest/V3/Description.ts (mainProperties, für alle Versionen 3 bis 4.3 gleich,
//   Unterschied nur bei options.redirect: followRedirects Default false bis v3, true ab v4)
//   packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts (version [3, 4, 4.1, 4.2, 4.3])
//   packages/nodes-base/credentials/Http*Auth.credentials.ts, OAuth1Api/OAuth2Api (genericAuth: true)
// Nicht übernommen: reine Oberflächenelemente (preBuiltAgentsCallout, curlImport, infoMessage zur Browser-Konsole), das
// Credential-Feld sslCertificate und die optimizeResponse-Parameter, die n8n nur beim Einsatz als Tool ('@tool') zeigt.
import type { ParamSchema } from '../params.js';

/** Auswahl "Using Fields Below / Using JSON" (specifyQuery, specifyHeaders, specifyBody bei JSON) */
const KEYPAIR_OR_JSON = [
  { value: 'keypair', label: 'Über Felder' },
  { value: 'json', label: 'Über JSON' },
];

/** fixedCollection mit Name/Wert-Paaren (queryParameters, headerParameters, bodyParameters) */
function nameValueCollection(name: string, label: string, show: ParamSchema['show'], withDescriptions = false): ParamSchema {
  return {
    name,
    label,
    type: 'fixedCollection',
    multiple: true,
    placeholder: 'Parameter hinzufügen',
    addLabel: 'Parameter hinzufügen',
    default: { parameters: [{ name: '', value: '' }] },
    show,
    groups: [
      {
        name: 'parameters',
        label: 'Parameter',
        children: [
          { name: 'name', label: 'Name', type: 'string', default: '', ...(withDescriptions ? { description: 'Name des Felds' } : {}) },
          { name: 'value', label: 'Wert', type: 'string', default: '', ...(withDescriptions ? { description: 'Wert des Felds' } : {}) },
        ],
      },
    ],
  };
}

/** options.redirect, je Version mit anderem Default für followRedirects */
function redirectOption(followDefault: boolean, display: Pick<ParamSchema, 'show' | 'hide'>): ParamSchema {
  return {
    name: 'redirect',
    label: 'Weiterleitungen',
    type: 'fixedCollection',
    placeholder: 'Weiterleitung hinzufügen',
    addLabel: 'Weiterleitung hinzufügen',
    default: { redirect: {} },
    ...display,
    groups: [
      {
        name: 'redirect',
        label: 'Weiterleitung',
        children: [
          {
            name: 'followRedirects',
            label: 'Weiterleitungen folgen',
            type: 'boolean',
            default: followDefault,
            noExpression: true,
            description: 'Ob allen Weiterleitungen gefolgt wird',
          },
          {
            name: 'maxRedirects',
            label: 'Höchstens Weiterleitungen',
            type: 'number',
            default: 21,
            show: { followRedirects: [true] },
            description: 'Höchstzahl der Weiterleitungen, denen gefolgt wird',
          },
        ],
      },
    ],
  };
}

export const httpRequestParameters: ParamSchema[] = [
  {
    name: 'method',
    label: 'Methode',
    type: 'options',
    default: 'GET',
    options: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].map((m) => ({ value: m, label: m })),
    description: 'HTTP-Methode des Requests',
  },
  {
    name: 'url',
    label: 'URL',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'http://example.com/index.html',
    description: 'URL, an die der Request geht',
  },
  {
    name: 'authentication',
    label: 'Authentifizierung',
    type: 'options',
    default: 'none',
    noExpression: true,
    options: [
      { value: 'none', label: 'Keine' },
      { value: 'predefinedCredentialType', label: 'Vordefinierter Credential-Typ', description: 'Fertige Anmeldung für einen Dienst' },
      { value: 'genericCredentialType', label: 'Generischer Credential-Typ', description: 'Frei konfigurierbar, z. B. Basic, Header oder OAuth2' },
    ],
  },
  {
    // n8n: type credentialsSelect (extends:oAuth2Api, extends:oAuth1Api, has:authenticate); filuflow kennt die
    // Authentifizierung der Typen in src/credentials/authenticate.ts und aus Plugins, validate meldet andere
    name: 'nodeCredentialType',
    label: 'Credential-Typ',
    type: 'string',
    default: '',
    required: true,
    noExpression: true,
    show: { authentication: ['predefinedCredentialType'] },
    description: 'Name des Credential-Typs, z. B. githubApi, notionApi, slackApi, stripeApi, airtableTokenApi, hubspotAppToken, openAiApi, anthropicApi oder ein Typ aus einem Plugin; Typen auf …OAuth2Api nutzen das verbundene Token',
  },
  {
    name: 'googleApiWarning',
    label: 'Im Credential müssen die Scopes für den Service Account angegeben sein',
    type: 'notice',
    default: '',
    show: { nodeCredentialType: ['googleApi'] },
  },
  {
    // n8n: type credentialsSelect (has:genericAuth); validate meldet Typen, die filuflow nicht unterstützt
    name: 'genericAuthType',
    label: 'Generischer Auth-Typ',
    type: 'options',
    default: '',
    required: true,
    show: { authentication: ['genericCredentialType'] },
    options: [
      { value: 'httpBasicAuth', label: 'Basic Auth' },
      { value: 'httpBearerAuth', label: 'Bearer Auth' },
      { value: 'httpCustomAuth', label: 'Custom Auth' },
      { value: 'httpDigestAuth', label: 'Digest Auth' },
      { value: 'httpHeaderAuth', label: 'Header Auth' },
      { value: 'oAuth1Api', label: 'OAuth1 API' },
      { value: 'oAuth2Api', label: 'OAuth2 API' },
      { value: 'httpQueryAuth', label: 'Query Auth' },
    ],
  },
  {
    name: 'provideSslCertificates',
    label: 'SSL-Zertifikate',
    type: 'boolean',
    default: false,
    description: 'Ob eigene Zertifikate aus dem Credential httpSslAuth verwendet werden',
  },
  {
    name: 'provideSslCertificatesNotice',
    label: 'Zertifikate im Credential für SSL-Zertifikate (httpSslAuth) hinterlegen',
    type: 'notice',
    default: '',
    show: { provideSslCertificates: [true] },
  },
  // Query
  {
    name: 'sendQuery',
    label: 'Query-Parameter senden',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Ob der Request Query-Parameter hat',
  },
  {
    name: 'specifyQuery',
    label: 'Query-Parameter angeben',
    type: 'options',
    default: 'keypair',
    show: { sendQuery: [true] },
    options: KEYPAIR_OR_JSON,
  },
  nameValueCollection('queryParameters', 'Query-Parameter', { sendQuery: [true], specifyQuery: ['keypair'] }),
  { name: 'jsonQuery', label: 'JSON', type: 'json', default: '', show: { sendQuery: [true], specifyQuery: ['json'] } },
  // Header
  {
    name: 'sendHeaders',
    label: 'Header senden',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Ob der Request Header hat',
  },
  {
    name: 'specifyHeaders',
    label: 'Header angeben',
    type: 'options',
    default: 'keypair',
    show: { sendHeaders: [true] },
    options: KEYPAIR_OR_JSON,
  },
  nameValueCollection('headerParameters', 'Header-Parameter', { sendHeaders: [true], specifyHeaders: ['keypair'] }),
  { name: 'jsonHeaders', label: 'JSON', type: 'json', default: '', show: { sendHeaders: [true], specifyHeaders: ['json'] } },
  // Body
  {
    name: 'sendBody',
    label: 'Body senden',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Ob der Request einen Body hat',
  },
  {
    name: 'contentType',
    label: 'Body-Content-Type',
    type: 'options',
    default: 'json',
    show: { sendBody: [true] },
    options: [
      { value: 'form-urlencoded', label: 'Form Urlencoded' },
      { value: 'multipart-form-data', label: 'Form-Data' },
      { value: 'json', label: 'JSON' },
      { value: 'binaryData', label: 'Binärdatei' },
      { value: 'raw', label: 'Raw' },
    ],
    description: 'Content-Type, mit dem der Body gesendet wird',
  },
  {
    name: 'specifyBody',
    label: 'Body angeben',
    type: 'options',
    default: 'keypair',
    show: { sendBody: [true], contentType: ['json'] },
    options: KEYPAIR_OR_JSON,
    description: 'Body über einzelne Felder (keypair) oder als JSON-Objekt (json)',
  },
  nameValueCollection('bodyParameters', 'Body-Parameter', { sendBody: [true], contentType: ['json'], specifyBody: ['keypair'] }, true),
  { name: 'jsonBody', label: 'JSON', type: 'json', default: '', show: { sendBody: [true], contentType: ['json'], specifyBody: ['json'] } },
  {
    name: 'bodyParameters',
    label: 'Body-Parameter',
    type: 'fixedCollection',
    multiple: true,
    placeholder: 'Parameter hinzufügen',
    addLabel: 'Parameter hinzufügen',
    default: { parameters: [{ name: '', value: '' }] },
    show: { sendBody: [true], contentType: ['multipart-form-data'] },
    groups: [
      {
        name: 'parameters',
        label: 'Parameter',
        children: [
          {
            name: 'parameterType',
            label: 'Parametertyp',
            type: 'options',
            default: 'formData',
            options: [
              { value: 'formBinaryData', label: 'Binärdatei' },
              { value: 'formData', label: 'Formulardaten' },
            ],
          },
          { name: 'name', label: 'Name', type: 'string', default: '', description: 'Name des Felds' },
          { name: 'value', label: 'Wert', type: 'string', default: '', show: { parameterType: ['formData'] }, description: 'Wert des Felds' },
          {
            name: 'inputDataFieldName',
            label: 'Binärfeld der Eingabe',
            type: 'string',
            default: '',
            show: { parameterType: ['formBinaryData'] },
            description: 'Name des Eingabefelds mit der Binärdatei',
          },
        ],
      },
    ],
  },
  {
    name: 'specifyBody',
    label: 'Body angeben',
    type: 'options',
    default: 'keypair',
    show: { sendBody: [true], contentType: ['form-urlencoded'] },
    options: [
      { value: 'keypair', label: 'Über Felder' },
      { value: 'string', label: 'Über ein einzelnes Feld' },
    ],
  },
  nameValueCollection('bodyParameters', 'Body-Parameter', { sendBody: [true], contentType: ['form-urlencoded'], specifyBody: ['keypair'] }, true),
  {
    // n8n zeigt dieses Feld ohne Bedingung auf contentType
    name: 'body',
    label: 'Body',
    type: 'string',
    default: '',
    placeholder: 'field1=value1&field2=value2',
    show: { sendBody: [true], specifyBody: ['string'] },
  },
  {
    name: 'inputDataFieldName',
    label: 'Binärfeld der Eingabe',
    type: 'string',
    default: '',
    show: { sendBody: [true], contentType: ['binaryData'] },
    description: 'Name des Eingabefelds mit der Binärdatei',
  },
  {
    name: 'rawContentType',
    label: 'Content-Type',
    type: 'string',
    default: '',
    placeholder: 'text/html',
    show: { sendBody: [true], contentType: ['raw'] },
  },
  { name: 'body', label: 'Body', type: 'string', default: '', placeholder: '', show: { sendBody: [true], contentType: ['raw'] } },
  // Optionen
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    placeholder: 'Option hinzufügen',
    addLabel: 'Option hinzufügen',
    children: [
      {
        name: 'batching',
        label: 'Batching',
        type: 'fixedCollection',
        placeholder: 'Batching hinzufügen',
        addLabel: 'Batching hinzufügen',
        default: { batch: {} },
        groups: [
          {
            name: 'batch',
            label: 'Batching',
            children: [
              {
                name: 'batchSize',
                label: 'Items pro Batch',
                type: 'number',
                default: 50,
                min: -1,
                description: 'Teilt die Eingabe zum Drosseln in Batches, -1 schaltet ab, 0 zählt als 1',
              },
              {
                name: 'batchInterval',
                label: 'Batch-Intervall (ms)',
                type: 'number',
                default: 1000,
                min: 0,
                description: 'Pause in Millisekunden zwischen den Batches, 0 schaltet ab',
              },
            ],
          },
        ],
      },
      {
        name: 'allowUnauthorizedCerts',
        label: 'SSL-Fehler ignorieren (unsicher)',
        type: 'boolean',
        default: false,
        noExpression: true,
        description: 'Ob die Antwort auch ohne gültiges SSL-Zertifikat geladen wird',
      },
      {
        name: 'queryParameterArrays',
        label: 'Array-Format in Query-Parametern',
        type: 'options',
        default: 'brackets',
        show: { '/sendQuery': [true] },
        options: [
          { value: 'repeat', label: 'Ohne Klammern', description: 'z. B. foo=bar&foo=qux' },
          { value: 'brackets', label: 'Nur Klammern', description: 'z. B. foo[]=bar&foo[]=qux' },
          { value: 'indices', label: 'Klammern mit Indizes', description: 'z. B. foo[0]=bar&foo[1]=qux' },
        ],
      },
      {
        name: 'lowercaseHeaders',
        label: 'Header kleinschreiben',
        type: 'boolean',
        default: true,
        description: 'Ob Header-Namen kleingeschrieben werden',
      },
      redirectOption(false, { show: { '@version': [1, 2, 3] } }),
      redirectOption(true, { hide: { '@version': [1, 2, 3] } }),
      {
        name: 'response',
        label: 'Antwort',
        type: 'fixedCollection',
        placeholder: 'Antwort hinzufügen',
        addLabel: 'Antwort hinzufügen',
        default: { response: {} },
        groups: [
          {
            name: 'response',
            label: 'Antwort',
            children: [
              {
                name: 'fullResponse',
                label: 'Header und Status mitliefern',
                type: 'boolean',
                default: false,
                description: 'Ob die ganze Antwort mit Headern und Statuscode statt nur des Bodys zurückkommt',
              },
              {
                name: 'neverError',
                label: 'Nie Fehler',
                type: 'boolean',
                default: false,
                description: 'Ob der Request auch bei Statuscodes außerhalb von 2xx gelingt',
              },
              {
                name: 'responseFormat',
                label: 'Antwortformat',
                type: 'options',
                default: 'autodetect',
                noExpression: true,
                options: [
                  { value: 'autodetect', label: 'Automatisch' },
                  { value: 'file', label: 'Datei' },
                  { value: 'json', label: 'JSON' },
                  { value: 'text', label: 'Text' },
                ],
                description: 'Format, in dem die Daten der URL zurückkommen',
              },
              {
                name: 'outputPropertyName',
                label: 'Ausgabe in Feld',
                type: 'string',
                default: 'data',
                required: true,
                show: { responseFormat: ['file', 'text'] },
                description: 'Name des Felds, in das die Antwort geschrieben wird',
              },
            ],
          },
        ],
      },
      {
        name: 'pagination',
        label: 'Pagination',
        type: 'fixedCollection',
        placeholder: 'Pagination hinzufügen',
        addLabel: 'Pagination hinzufügen',
        default: { pagination: {} },
        groups: [
          {
            name: 'pagination',
            label: 'Pagination',
            children: [
              {
                name: 'paginationMode',
                label: 'Pagination-Modus',
                type: 'options',
                default: 'updateAParameterInEachRequest',
                noExpression: true,
                options: [
                  { value: 'off', label: 'Aus' },
                  { value: 'updateAParameterInEachRequest', label: 'Parameter in jedem Request ändern' },
                  { value: 'responseContainsNextURL', label: 'Antwort enthält nächste URL' },
                ],
                description: 'Ob und wie Pagination verwendet wird',
              },
              {
                name: 'webhookNotice',
                label: 'Mit den $response-Variablen auf die Daten der vorigen Antwort zugreifen',
                type: 'notice',
                default: '',
                hide: { paginationMode: ['off'] },
              },
              {
                name: 'nextURL',
                label: 'Nächste URL',
                type: 'string',
                default: '',
                show: { paginationMode: ['responseContainsNextURL'] },
                description: 'Muss die URL der nächsten Seite ergeben',
              },
              {
                name: 'parameters',
                label: 'Parameter',
                type: 'fixedCollection',
                multiple: true,
                noExpression: true,
                placeholder: 'Parameter hinzufügen',
                addLabel: 'Parameter hinzufügen',
                default: { parameters: [{ type: 'qs', name: '', value: '' }] },
                show: { paginationMode: ['updateAParameterInEachRequest'] },
                groups: [
                  {
                    name: 'parameters',
                    label: 'Parameter',
                    children: [
                      {
                        name: 'type',
                        label: 'Typ',
                        type: 'options',
                        default: 'qs',
                        options: [
                          { value: 'body', label: 'Body' },
                          { value: 'headers', label: 'Header' },
                          { value: 'qs', label: 'Query' },
                        ],
                        description: 'Wo der Parameter gesetzt wird',
                      },
                      { name: 'name', label: 'Name', type: 'string', default: '', placeholder: 'z. B. page' },
                      {
                        name: 'value',
                        label: 'Wert',
                        type: 'string',
                        default: '',
                        description: 'Im Expression-Modus mit $response auf die Antwort zugreifen',
                      },
                    ],
                  },
                ],
              },
              {
                name: 'paginationCompleteWhen',
                label: 'Pagination fertig, wenn',
                type: 'options',
                default: 'responseIsEmpty',
                noExpression: true,
                hide: { paginationMode: ['off'] },
                options: [
                  { value: 'responseIsEmpty', label: 'Antwort ist leer' },
                  { value: 'receiveSpecificStatusCodes', label: 'Bestimmte Statuscodes kommen' },
                  { value: 'other', label: 'Andere Bedingung' },
                ],
                description: 'Wann keine weiteren Requests folgen',
              },
              {
                name: 'statusCodesWhenComplete',
                label: 'Statuscodes für Ende',
                type: 'string',
                default: '',
                noExpression: true,
                show: { paginationCompleteWhen: ['receiveSpecificStatusCodes'] },
                description: 'Mehrere Werte durch Kommas trennen',
              },
              {
                name: 'completeExpression',
                label: 'Expression für Ende',
                type: 'string',
                default: '',
                show: { paginationCompleteWhen: ['other'] },
                description: 'Muss true ergeben, wenn die Pagination fertig ist',
              },
              {
                name: 'limitPagesFetched',
                label: 'Seitenzahl begrenzen',
                type: 'boolean',
                default: false,
                noExpression: true,
                hide: { paginationMode: ['off'] },
                description: 'Ob die Zahl der Requests begrenzt wird',
              },
              {
                name: 'maxRequests',
                label: 'Höchstens Seiten',
                type: 'number',
                default: 100,
                noExpression: true,
                show: { limitPagesFetched: [true] },
                description: 'Höchstzahl der Requests',
              },
              {
                name: 'requestInterval',
                label: 'Pause zwischen Requests (ms)',
                type: 'number',
                default: 0,
                min: 0,
                hide: { paginationMode: ['off'] },
                description: 'Wartezeit in Millisekunden zwischen den Requests, 0 ohne Pause',
              },
            ],
          },
        ],
      },
      {
        name: 'proxy',
        label: 'Proxy',
        type: 'string',
        default: '',
        placeholder: 'z. B. http://myproxy:3128',
        description: 'Zu verwendender HTTP-Proxy',
      },
      {
        name: 'timeout',
        label: 'Timeout',
        type: 'number',
        default: 10000,
        min: 1,
        description: 'Wartezeit in ms auf die Antwort-Header, danach Abbruch',
      },
    ],
  },
];

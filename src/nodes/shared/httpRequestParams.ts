// Parameters of the HTTP Request (n8n-nodes-base.httpRequest, typeVersion 3, 4, 4.1, 4.2, 4.3) for the editor form.
// Rebuilt after n8n 1.123.0:
//   packages/nodes-base/nodes/HttpRequest/V3/Description.ts (mainProperties, the same for all versions 3 to 4.3,
//   only difference in options.redirect: followRedirects default false up to v3, true from v4)
//   packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts (version [3, 4, 4.1, 4.2, 4.3])
//   packages/nodes-base/credentials/Http*Auth.credentials.ts, OAuth1Api/OAuth2Api (genericAuth: true)
// Not included: pure UI elements (preBuiltAgentsCallout, curlImport, infoMessage about the browser console), the
// credential field sslCertificate and the optimizeResponse parameters, which n8n only shows when used as a tool ('@tool').
import type { ParamSchema } from '../params.js';

/** Choice "Using Fields Below / Using JSON" (specifyQuery, specifyHeaders, specifyBody for JSON) */
const KEYPAIR_OR_JSON = [
  { value: 'keypair', label: 'Using Fields Below' },
  { value: 'json', label: 'Using JSON' },
];

/** fixedCollection with name/value pairs (queryParameters, headerParameters, bodyParameters) */
function nameValueCollection(name: string, label: string, show: ParamSchema['show'], withDescriptions = false): ParamSchema {
  return {
    name,
    label,
    type: 'fixedCollection',
    multiple: true,
    placeholder: 'Add Parameter',
    addLabel: 'Add Parameter',
    default: { parameters: [{ name: '', value: '' }] },
    show,
    groups: [
      {
        name: 'parameters',
        label: 'Parameter',
        children: [
          { name: 'name', label: 'Name', type: 'string', default: '', ...(withDescriptions ? { description: 'ID of the field to set' } : {}) },
          { name: 'value', label: 'Value', type: 'string', default: '', ...(withDescriptions ? { description: 'Value of the field to set' } : {}) },
        ],
      },
    ],
  };
}

/** options.redirect, with a different followRedirects default per version */
function redirectOption(followDefault: boolean, display: Pick<ParamSchema, 'show' | 'hide'>): ParamSchema {
  return {
    name: 'redirect',
    label: 'Redirects',
    type: 'fixedCollection',
    placeholder: 'Add Redirect',
    addLabel: 'Add Redirect',
    default: { redirect: {} },
    ...display,
    groups: [
      {
        name: 'redirect',
        label: 'Redirect',
        children: [
          {
            name: 'followRedirects',
            label: 'Follow Redirects',
            type: 'boolean',
            default: followDefault,
            noExpression: true,
            description: 'Whether to follow all redirects',
          },
          {
            name: 'maxRedirects',
            label: 'Max Redirects',
            type: 'number',
            default: 21,
            show: { followRedirects: [true] },
            description: 'Max number of redirects to follow',
          },
        ],
      },
    ],
  };
}

export const httpRequestParameters: ParamSchema[] = [
  {
    name: 'method',
    label: 'Method',
    type: 'options',
    default: 'GET',
    options: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].map((m) => ({ value: m, label: m })),
    description: 'The request method to use',
  },
  {
    name: 'url',
    label: 'URL',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'http://example.com/index.html',
    description: 'The URL to make the request to',
  },
  {
    name: 'authentication',
    label: 'Authentication',
    type: 'options',
    default: 'none',
    noExpression: true,
    options: [
      { value: 'none', label: 'None' },
      { value: 'predefinedCredentialType', label: 'Predefined Credential Type', description: 'Ready-made credentials for a service' },
      { value: 'genericCredentialType', label: 'Generic Credential Type', description: 'Fully customizable, e.g. Basic, Header or OAuth2' },
    ],
  },
  {
    // n8n: type credentialsSelect (extends:oAuth2Api, extends:oAuth1Api, has:authenticate); filuflow knows the
    // authentication of the types in src/credentials/authenticate.ts and from plugins, validate reports others
    name: 'nodeCredentialType',
    label: 'Credential Type',
    type: 'string',
    default: '',
    required: true,
    noExpression: true,
    show: { authentication: ['predefinedCredentialType'] },
    description: 'Name of the credential type, e.g. githubApi, notionApi, slackApi, stripeApi, airtableTokenApi, hubspotAppToken, openAiApi, anthropicApi or a type from a plugin; OAuth2 types (e.g. googleSheetsOAuth2Api, slackOAuth2Api) use the connected token',
  },
  {
    name: 'googleApiWarning',
    label: 'Scopes for the service account must be specified in the credential',
    type: 'notice',
    default: '',
    show: { nodeCredentialType: ['googleApi'] },
  },
  {
    // n8n: type credentialsSelect (has:genericAuth); validate reports types filuflow does not support
    name: 'genericAuthType',
    label: 'Generic Auth Type',
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
    label: 'SSL Certificates',
    type: 'boolean',
    default: false,
    description: 'Whether to use custom certificates from the httpSslAuth credential',
  },
  {
    name: 'provideSslCertificatesNotice',
    label: 'Provide certificates in the SSL Certificates credential (httpSslAuth)',
    type: 'notice',
    default: '',
    show: { provideSslCertificates: [true] },
  },
  // Query
  {
    name: 'sendQuery',
    label: 'Send Query Parameters',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Whether the request has query params or not',
  },
  {
    name: 'specifyQuery',
    label: 'Specify Query Parameters',
    type: 'options',
    default: 'keypair',
    show: { sendQuery: [true] },
    options: KEYPAIR_OR_JSON,
  },
  nameValueCollection('queryParameters', 'Query Parameters', { sendQuery: [true], specifyQuery: ['keypair'] }),
  { name: 'jsonQuery', label: 'JSON', type: 'json', default: '', show: { sendQuery: [true], specifyQuery: ['json'] } },
  // Header
  {
    name: 'sendHeaders',
    label: 'Send Headers',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Whether the request has headers or not',
  },
  {
    name: 'specifyHeaders',
    label: 'Specify Headers',
    type: 'options',
    default: 'keypair',
    show: { sendHeaders: [true] },
    options: KEYPAIR_OR_JSON,
  },
  nameValueCollection('headerParameters', 'Header Parameters', { sendHeaders: [true], specifyHeaders: ['keypair'] }),
  { name: 'jsonHeaders', label: 'JSON', type: 'json', default: '', show: { sendHeaders: [true], specifyHeaders: ['json'] } },
  // Body
  {
    name: 'sendBody',
    label: 'Send Body',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Whether the request has a body or not',
  },
  {
    name: 'contentType',
    label: 'Body Content Type',
    type: 'options',
    default: 'json',
    show: { sendBody: [true] },
    options: [
      { value: 'form-urlencoded', label: 'Form Urlencoded' },
      { value: 'multipart-form-data', label: 'Form-Data' },
      { value: 'json', label: 'JSON' },
      { value: 'binaryData', label: 'n8n Binary File' },
      { value: 'raw', label: 'Raw' },
    ],
    description: 'Content type used to send the body',
  },
  {
    name: 'specifyBody',
    label: 'Specify Body',
    type: 'options',
    default: 'keypair',
    show: { sendBody: [true], contentType: ['json'] },
    options: KEYPAIR_OR_JSON,
    description: 'Body as individual fields (keypair) or as a JSON object (json)',
  },
  nameValueCollection('bodyParameters', 'Body Parameters', { sendBody: [true], contentType: ['json'], specifyBody: ['keypair'] }, true),
  { name: 'jsonBody', label: 'JSON', type: 'json', default: '', show: { sendBody: [true], contentType: ['json'], specifyBody: ['json'] } },
  {
    name: 'bodyParameters',
    label: 'Body Parameters',
    type: 'fixedCollection',
    multiple: true,
    placeholder: 'Add Parameter',
    addLabel: 'Add Parameter',
    default: { parameters: [{ name: '', value: '' }] },
    show: { sendBody: [true], contentType: ['multipart-form-data'] },
    groups: [
      {
        name: 'parameters',
        label: 'Parameter',
        children: [
          {
            name: 'parameterType',
            label: 'Parameter Type',
            type: 'options',
            default: 'formData',
            options: [
              { value: 'formBinaryData', label: 'n8n Binary File' },
              { value: 'formData', label: 'Form Data' },
            ],
          },
          { name: 'name', label: 'Name', type: 'string', default: '', description: 'ID of the field to set' },
          { name: 'value', label: 'Value', type: 'string', default: '', show: { parameterType: ['formData'] }, description: 'Value of the field to set' },
          {
            name: 'inputDataFieldName',
            label: 'Input Data Field Name',
            type: 'string',
            default: '',
            show: { parameterType: ['formBinaryData'] },
            description: 'The name of the incoming field containing the binary file data to be processed',
          },
        ],
      },
    ],
  },
  {
    name: 'specifyBody',
    label: 'Specify Body',
    type: 'options',
    default: 'keypair',
    show: { sendBody: [true], contentType: ['form-urlencoded'] },
    options: [
      { value: 'keypair', label: 'Using Fields Below' },
      { value: 'string', label: 'Using Single Field' },
    ],
  },
  nameValueCollection('bodyParameters', 'Body Parameters', { sendBody: [true], contentType: ['form-urlencoded'], specifyBody: ['keypair'] }, true),
  {
    // n8n shows this field without a condition on contentType
    name: 'body',
    label: 'Body',
    type: 'string',
    default: '',
    placeholder: 'field1=value1&field2=value2',
    show: { sendBody: [true], specifyBody: ['string'] },
  },
  {
    name: 'inputDataFieldName',
    label: 'Input Data Field Name',
    type: 'string',
    default: '',
    show: { sendBody: [true], contentType: ['binaryData'] },
    description: 'The name of the incoming field containing the binary file data to be processed',
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
  // Options
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add Option',
    addLabel: 'Add Option',
    children: [
      {
        name: 'batching',
        label: 'Batching',
        type: 'fixedCollection',
        placeholder: 'Add Batching',
        addLabel: 'Add Batching',
        default: { batch: {} },
        groups: [
          {
            name: 'batch',
            label: 'Batching',
            children: [
              {
                name: 'batchSize',
                label: 'Items per Batch',
                type: 'number',
                default: 50,
                min: -1,
                description: 'Input will be split in batches to throttle requests; -1 to disable, 0 is treated as 1',
              },
              {
                name: 'batchInterval',
                label: 'Batch Interval (ms)',
                type: 'number',
                default: 1000,
                min: 0,
                description: 'Time (in milliseconds) between each batch of requests; 0 to disable',
              },
            ],
          },
        ],
      },
      {
        name: 'allowUnauthorizedCerts',
        label: 'Ignore SSL Issues (Insecure)',
        type: 'boolean',
        default: false,
        noExpression: true,
        description: 'Whether to download the response even if SSL certificate validation is not possible',
      },
      {
        name: 'queryParameterArrays',
        label: 'Array Format in Query Parameters',
        type: 'options',
        default: 'brackets',
        show: { '/sendQuery': [true] },
        options: [
          { value: 'repeat', label: 'No Brackets', description: 'e.g. foo=bar&foo=qux' },
          { value: 'brackets', label: 'Brackets Only', description: 'e.g. foo[]=bar&foo[]=qux' },
          { value: 'indices', label: 'Brackets with Indices', description: 'e.g. foo[0]=bar&foo[1]=qux' },
        ],
      },
      {
        name: 'lowercaseHeaders',
        label: 'Lowercase Headers',
        type: 'boolean',
        default: true,
        description: 'Whether to lowercase header names',
      },
      redirectOption(false, { show: { '@version': [1, 2, 3] } }),
      redirectOption(true, { hide: { '@version': [1, 2, 3] } }),
      {
        name: 'response',
        label: 'Response',
        type: 'fixedCollection',
        placeholder: 'Add Response',
        addLabel: 'Add Response',
        default: { response: {} },
        groups: [
          {
            name: 'response',
            label: 'Response',
            children: [
              {
                name: 'fullResponse',
                label: 'Include Response Headers and Status',
                type: 'boolean',
                default: false,
                description: 'Whether to return the full response (headers and response status code) data instead of only the body',
              },
              {
                name: 'neverError',
                label: 'Never Error',
                type: 'boolean',
                default: false,
                description: 'Whether to succeed even when the response status code is not 2xx',
              },
              {
                name: 'responseFormat',
                label: 'Response Format',
                type: 'options',
                default: 'autodetect',
                noExpression: true,
                options: [
                  { value: 'autodetect', label: 'Autodetect' },
                  { value: 'file', label: 'File' },
                  { value: 'json', label: 'JSON' },
                  { value: 'text', label: 'Text' },
                ],
                description: 'The format in which the data gets returned from the URL',
              },
              {
                name: 'outputPropertyName',
                label: 'Put Output in Field',
                type: 'string',
                default: 'data',
                required: true,
                show: { responseFormat: ['file', 'text'] },
                description: 'Name of the field to put the response output in',
              },
            ],
          },
        ],
      },
      {
        name: 'pagination',
        label: 'Pagination',
        type: 'fixedCollection',
        placeholder: 'Add Pagination',
        addLabel: 'Add Pagination',
        default: { pagination: {} },
        groups: [
          {
            name: 'pagination',
            label: 'Pagination',
            children: [
              {
                name: 'paginationMode',
                label: 'Pagination Mode',
                type: 'options',
                default: 'updateAParameterInEachRequest',
                noExpression: true,
                options: [
                  { value: 'off', label: 'Off' },
                  { value: 'updateAParameterInEachRequest', label: 'Update a Parameter in Each Request' },
                  { value: 'responseContainsNextURL', label: 'Response Contains Next URL' },
                ],
                description: 'If pagination should be used',
              },
              {
                name: 'webhookNotice',
                label: 'Use the $response variables to access the data of the previous response',
                type: 'notice',
                default: '',
                hide: { paginationMode: ['off'] },
              },
              {
                name: 'nextURL',
                label: 'Next URL',
                type: 'string',
                default: '',
                show: { paginationMode: ['responseContainsNextURL'] },
                description: 'Should evaluate to the URL of the next page',
              },
              {
                name: 'parameters',
                label: 'Parameter',
                type: 'fixedCollection',
                multiple: true,
                noExpression: true,
                placeholder: 'Add Parameter',
                addLabel: 'Add Parameter',
                default: { parameters: [{ type: 'qs', name: '', value: '' }] },
                show: { paginationMode: ['updateAParameterInEachRequest'] },
                groups: [
                  {
                    name: 'parameters',
                    label: 'Parameter',
                    children: [
                      {
                        name: 'type',
                        label: 'Type',
                        type: 'options',
                        default: 'qs',
                        options: [
                          { value: 'body', label: 'Body' },
                          { value: 'headers', label: 'Header' },
                          { value: 'qs', label: 'Query' },
                        ],
                        description: 'Where the parameter should be set',
                      },
                      { name: 'name', label: 'Name', type: 'string', default: '', placeholder: 'e.g. page' },
                      {
                        name: 'value',
                        label: 'Value',
                        type: 'string',
                        default: '',
                        description: 'In expression mode, use $response to access the response',
                      },
                    ],
                  },
                ],
              },
              {
                name: 'paginationCompleteWhen',
                label: 'Pagination Complete When',
                type: 'options',
                default: 'responseIsEmpty',
                noExpression: true,
                hide: { paginationMode: ['off'] },
                options: [
                  { value: 'responseIsEmpty', label: 'Response Is Empty' },
                  { value: 'receiveSpecificStatusCodes', label: 'Receive Specific Status Codes' },
                  { value: 'other', label: 'Other' },
                ],
                description: 'When no more requests should be made',
              },
              {
                name: 'statusCodesWhenComplete',
                label: 'Status Code(s) when Complete',
                type: 'string',
                default: '',
                noExpression: true,
                show: { paginationCompleteWhen: ['receiveSpecificStatusCodes'] },
                description: 'Accepts comma-separated values',
              },
              {
                name: 'completeExpression',
                label: 'Complete Expression',
                type: 'string',
                default: '',
                show: { paginationCompleteWhen: ['other'] },
                description: 'Should evaluate to true when pagination is complete',
              },
              {
                name: 'limitPagesFetched',
                label: 'Limit Pages Fetched',
                type: 'boolean',
                default: false,
                noExpression: true,
                hide: { paginationMode: ['off'] },
                description: 'Whether the number of requests should be limited',
              },
              {
                name: 'maxRequests',
                label: 'Max Pages',
                type: 'number',
                default: 100,
                noExpression: true,
                show: { limitPagesFetched: [true] },
                description: 'Maximum amount of requests to make',
              },
              {
                name: 'requestInterval',
                label: 'Interval Between Requests (ms)',
                type: 'number',
                default: 0,
                min: 0,
                hide: { paginationMode: ['off'] },
                description: 'Time in milliseconds to wait between requests; 0 for no wait',
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
        placeholder: 'e.g. http://myproxy:3128',
        description: 'HTTP proxy to use',
      },
      {
        name: 'timeout',
        label: 'Timeout',
        type: 'number',
        default: 10000,
        min: 1,
        description: 'Time in ms to wait for the server to send response headers before aborting the request',
      },
    ],
  },
];

// Messages of API errors per HTTP status code, shared by the service nodes (Gmail M40, Slack M48).
// Reference: n8n-workflow (reference version 1.123.0), src/errors/node-api.error.ts STATUS_CODE_MESSAGES.

/** NodeApiError messages per status code */
export const STATUS_CODE_MESSAGES: Record<string, string> = {
  '4XX': 'Your request is invalid or could not be processed by the service',
  '400': 'Bad request - please check your parameters',
  '401': 'Authorization failed - please check your credentials',
  '402': 'Payment required - perhaps check your payment details?',
  '403': 'Forbidden - perhaps check your credentials?',
  '404': 'The resource you are requesting could not be found',
  '405': 'Method not allowed - please check you are using the right HTTP method',
  '429': 'The service is receiving too many requests from you',
  '5XX': 'The service failed to process your request',
  '500': 'The service was not able to process your request',
  '502': 'Bad gateway - the service failed to handle your request',
  '503': 'Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)',
  '504': 'Gateway timed out - perhaps try again later?',
};

/** Message for a status code: exact code, else the 4XX or 5XX group, else a generic text */
export function statusCodeMessage(code: string | number): string {
  const c = String(code);
  return STATUS_CODE_MESSAGES[c] ?? (c.startsWith('4') ? STATUS_CODE_MESSAGES['4XX'] : c.startsWith('5') ? STATUS_CODE_MESSAGES['5XX'] : `Request failed with status code ${c}`);
}

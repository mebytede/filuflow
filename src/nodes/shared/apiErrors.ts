// Messages of API errors per HTTP status code, shared by the service nodes (Gmail M40, Slack M48, Outlook M50).
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

/** Keys that can hold an error text in an API response, in order of precedence (reference: POSSIBLE_ERROR_MESSAGE_KEYS) */
const ERROR_MESSAGE_KEYS = [
  'cause', 'error', 'message', 'Message', 'msg', 'messages', 'description', 'reason', 'detail', 'details', 'errors', 'errorMessage', 'errorMessages',
  'ErrorMessage', 'error_message', '_error_message', 'errorDescription', 'error_description', 'error_summary', 'error_info', 'title', 'text', 'field', 'err', 'type',
];
/** Keys of nested objects searched after the top level (reference: POSSIBLE_NESTED_ERROR_OBJECT_KEYS) */
const NESTED_ERROR_KEYS = ['Error', 'error', 'err', 'response', 'body', 'data'];

const traversable = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;

/**
 * Error text of an API response body like NodeApiError.findProperty (n8n-workflow, reference version 1.123.0,
 * src/errors/abstract/node.error.ts): the first key with a text (JSON texts are parsed), number or nested text; lists
 * are joined with " | "; then the nested objects. Used by the Outlook node (M50) for the description of API errors.
 */
export function findErrorDescription(body: unknown, keys: string[] = ERROR_MESSAGE_KEYS, nested: string[] = NESTED_ERROR_KEYS): string | null {
  if (!traversable(body)) return typeof body === 'string' && body ? body : null;
  for (const key of keys) {
    let value = body[key];
    if (!value) continue;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return value as string;
      }
      if (typeof value === 'string') return value;
    }
    if (typeof value === 'number') return value.toString();
    if (Array.isArray(value)) {
      const resolved = value
        .map((v) => (typeof v === 'string' ? v : typeof v === 'number' ? v.toString() : traversable(v) ? findErrorDescription(v, keys, []) : null))
        .filter((v) => v !== null);
      return resolved.length ? resolved.join(' | ') : null;
    }
    if (traversable(value)) {
      const found = findErrorDescription(value, keys, []);
      if (found) return found;
    }
  }
  for (const key of nested) {
    const value = body[key];
    if (traversable(value)) {
      const found = findErrorDescription(value, keys, nested);
      if (found) return found;
    }
  }
  return null;
}

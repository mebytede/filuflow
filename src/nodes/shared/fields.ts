// reference: packages/nodes-base/nodes/Transform/utils/utils.ts (prepareFieldsArray)
import { NodeOperationError } from '../../errors.js';

export function prepareFieldsArray(fields: string | string[], fieldName = 'Fields'): string[] {
  if (typeof fields === 'string') {
    return fields
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '');
  }
  if (Array.isArray(fields)) return fields;
  throw new NodeOperationError('', `The '${fieldName}' parameter must be a string of fields separated by commas or an array of strings.`);
}

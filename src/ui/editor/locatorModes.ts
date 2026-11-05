// Resource locator modes in the editor (M47b), without DOM so tests can check them directly: which "list" modes the
// editor can offer as a searchable list, and the validation rules of ID and URL modes (reference: INodePropertyMode
// validation with type "regex", checked while typing; empty values and expressions are not checked).
import type { ParamSchema } from '../types.js';

export type LocatorMode = NonNullable<ParamSchema['modes']>[number];

/** Is this mode a list the editor can offer here (search method with a backend, or the workflow picker)? */
export function canListMode(mode: LocatorMode | undefined, host: { load?: unknown; workflows?: unknown } | undefined): boolean {
  if (!mode || !host) return false;
  if (mode.type !== undefined ? mode.type !== 'list' : mode.name !== 'list') return false;
  if (mode.listSource === 'workflows') return !!host.workflows;
  return !!mode.searchListMethod && !!host.load;
}

/** First validation rule of the mode that the text does not satisfy (its errorMessage), undefined when it is valid */
export function locatorValidationError(mode: LocatorMode | undefined, value: unknown): string | undefined {
  if (!mode?.validation?.length || typeof value !== 'string' || value === '' || value.startsWith('=')) return undefined;
  for (const rule of mode.validation) {
    try {
      if (!new RegExp(rule.regex).test(value)) return rule.errorMessage;
    } catch {
      // invalid pattern in the description: no check
    }
  }
  return undefined;
}

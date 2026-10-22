// Description of a node type's parameters for the forms in the editor (M19).
// The format is our own simplified version of the n8n parameter description (INodeProperties in
// packages/workflow/src/interfaces.ts): same parameter names, defaults and visibility rules as n8n, so that
// saved workflows have the same structure. The description only drives the form; execution still reads the
// parameters itself (with the same defaults).

/** Condition in a visibility rule (n8n displayOptions with _cnd) */
export interface ParamCondition {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
  not?: unknown;
  exists?: boolean;
  startsWith?: string;
  endsWith?: string;
  includes?: string;
}

/**
 * Visibility like n8n displayOptions.show/hide: the key is a parameter on the same level, with a leading "/"
 * a top-level parameter, "@version" the typeVersion. Values are allowed values or { _cnd: condition }.
 */
export type DisplayRule = Record<string, Array<string | number | boolean | null | { _cnd: ParamCondition }>>;

export interface ParamOption {
  value: string | number | boolean;
  label: string;
  description?: string;
}

export type ParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'multiOptions'
  | 'json'
  | 'code'
  | 'dateTime'
  | 'color'
  | 'collection'
  | 'fixedCollection'
  | 'assignments'
  | 'filter'
  | 'resourceLocator'
  | 'notice'
  | 'hidden';

export interface ParamSchema {
  /** Name in the parameter object (as in n8n) */
  name: string;
  /** Label in the form (English, translated in the interface) */
  label: string;
  type: ParamType;
  /** Default as in n8n */
  default?: unknown;
  description?: string;
  placeholder?: string;
  required?: boolean;
  show?: DisplayRule;
  hide?: DisplayRule;
  /** options, multiOptions */
  options?: ParamOption[];
  /** string: multi-line with this number of rows (typeOptions.rows) */
  rows?: number;
  /** string: masked input (typeOptions.password) */
  password?: boolean;
  /** code: language for display and help text */
  language?: 'javaScript' | 'python' | 'json' | 'html' | 'sql' | 'css';
  /** number: limits (typeOptions.minValue, maxValue, numberPrecision) */
  min?: number;
  max?: number;
  precision?: number;
  /** fixedCollection: multiple entries per group (typeOptions.multipleValues); string: list of texts */
  multiple?: boolean;
  /** No expression allowed (noDataExpression) */
  noExpression?: boolean;
  /** collection: possible sub-parameters (added one by one) */
  children?: ParamSchema[];
  /** fixedCollection: groups with their fields */
  groups?: Array<{ name: string; label: string; children: ParamSchema[] }>;
  /** collection, fixedCollection: label of the add button */
  addLabel?: string;
  /** resourceLocator: modes (e.g. list, id, url); "list" is offered as free input */
  modes?: Array<{ name: string; label: string; placeholder?: string }>;
}

// Description of a node type's parameters for the forms in the editor (M19).
// The format is our own simplified version of the reference parameter description (INodeProperties in
// packages/workflow/src/interfaces.ts): same parameter names, defaults and visibility rules as the reference, so that
// saved workflows have the same structure. The description only drives the form; execution still reads the
// parameters itself (with the same defaults).

/** Condition in a visibility rule (reference: displayOptions with _cnd) */
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
 * Visibility like the reference displayOptions.show/hide: the key is a parameter on the same level, with a leading "/"
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
  /** Name in the parameter object (as in the reference) */
  name: string;
  /** Label in the form (English, translated in the interface) */
  label: string;
  type: ParamType;
  /** Default as in the reference */
  default?: unknown;
  description?: string;
  placeholder?: string;
  required?: boolean;
  show?: DisplayRule;
  hide?: DisplayRule;
  /** options, multiOptions: static list (empty or missing when the list is loaded, see loadOptions) */
  options?: ParamOption[];
  /**
   * options, multiOptions: list loaded from the node's methods.loadOptions[method] in the editor (M47a, like the reference
   * typeOptions.loadOptionsMethod and loadOptionsDependsOn). dependsOn: parameter paths from the top level, or "&name"
   * relative to the field's level; the list is reloaded when they change and they must resolve when they are expressions.
   */
  loadOptions?: LoadOptionsSpec;
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
  /**
   * resourceLocator: modes (e.g. list, id, url). A "list" mode with searchListMethod (or listSource) opens a searchable
   * list in the editor (M47b); without them it is a text field.
   */
  modes?: ResourceLocatorMode[];
}

export interface LoadOptionsSpec {
  /** Name of the function in methods.loadOptions of the node type */
  method: string;
  dependsOn?: string[];
}

/** Mode of a resource locator (reference: INodePropertyMode) */
export interface ResourceLocatorMode {
  name: string;
  label: string;
  placeholder?: string;
  /** Kind of input (reference: type); without it the mode is a text field */
  type?: 'list' | 'id' | 'url' | 'string';
  /** list: function in methods.listSearch of the node type */
  searchListMethod?: string;
  /** list: the search runs on the server with the filter text */
  searchable?: boolean;
  /** list: nothing is loaded without a filter text */
  searchFilterRequired?: boolean;
  /** url: regular expression whose first group is the value used by the node */
  extractValue?: { regex: string };
  /** id, url: checks in the editor */
  validation?: Array<{ regex: string; errorMessage: string }>;
  /**
   * list: list provided by the editor instead of a node method; "workflows" lists the workflows the editor can see (the
   * reference workflowSelector: standalone all workflows of the server, master the workflows of the same project)
   */
  listSource?: 'workflows';
}

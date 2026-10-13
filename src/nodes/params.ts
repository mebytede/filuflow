// Beschreibung der Parameter eines Knotentyps für die Formulare im Editor (M19).
// Das Format ist eine eigene, vereinfachte Fassung der n8n-Parameterbeschreibung (INodeProperties in
// packages/workflow/src/interfaces.ts): gleiche Parameternamen, Defaults und Sichtbarkeitsregeln wie n8n, damit
// gespeicherte Workflows dieselbe Struktur haben. Die Beschreibung steuert nur das Formular; die Ausführung liest die
// Parameter weiter selbst (mit denselben Defaults).

/** Bedingung in einer Sichtbarkeitsregel (n8n displayOptions mit _cnd) */
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
 * Sichtbarkeit wie n8n displayOptions.show/hide: Schlüssel ist ein Parameter auf derselben Ebene, mit führendem "/"
 * ein Parameter der obersten Ebene, "@version" die typeVersion. Werte sind erlaubte Werte oder { _cnd: Bedingung }.
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
  /** Name im Parameterobjekt (wie n8n) */
  name: string;
  /** Beschriftung im Formular (deutsch) */
  label: string;
  type: ParamType;
  /** Default wie in n8n */
  default?: unknown;
  description?: string;
  placeholder?: string;
  required?: boolean;
  show?: DisplayRule;
  hide?: DisplayRule;
  /** options, multiOptions */
  options?: ParamOption[];
  /** string: mehrzeilig mit dieser Zeilenzahl (typeOptions.rows) */
  rows?: number;
  /** string: verdeckte Eingabe (typeOptions.password) */
  password?: boolean;
  /** code: Sprache für Darstellung und Hilfetext */
  language?: 'javaScript' | 'python' | 'json' | 'html' | 'sql' | 'css';
  /** number: Grenzen (typeOptions.minValue, maxValue, numberPrecision) */
  min?: number;
  max?: number;
  precision?: number;
  /** fixedCollection: mehrere Einträge je Gruppe (typeOptions.multipleValues); string: Liste von Texten */
  multiple?: boolean;
  /** Keine Expression erlaubt (noDataExpression) */
  noExpression?: boolean;
  /** collection: mögliche Unterparameter (werden einzeln hinzugefügt) */
  children?: ParamSchema[];
  /** fixedCollection: Gruppen mit ihren Feldern */
  groups?: Array<{ name: string; label: string; children: ParamSchema[] }>;
  /** collection, fixedCollection: Beschriftung des Knopfs zum Hinzufügen */
  addLabel?: string;
  /** resourceLocator: Modi (z. B. list, id, url); "list" wird als freie Eingabe angeboten */
  modes?: Array<{ name: string; label: string; placeholder?: string }>;
}

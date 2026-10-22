// Interface language: English by default, German selectable per browser (localStorage, like the theme).
// Source strings are English and double as keys; German translations live in src/ui/locales/de/*.ts.
// Labels that come from the server (node parameters, credential fields) are English and are translated here too.
import { de } from './locales/de/index.js';

export type Locale = 'en' | 'de';

const KEY = 'filuflow.locale';
let current: Locale | undefined;

export function getLocale(): Locale {
  if (current) return current;
  try {
    current = localStorage.getItem(KEY) === 'de' ? 'de' : 'en';
  } catch {
    current = 'en';
  }
  return current;
}

/** Switch the language; the page reloads so every view is rendered again */
export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // Storage unavailable: applies until the page is reloaded
  }
  current = locale;
  location.reload();
}

/** BCP 47 tag for dates and numbers */
export function dateLocale(): string {
  return getLocale() === 'de' ? 'de-DE' : 'en-GB';
}

/** Set lang on the root element (screen readers, hyphenation) */
export function applyLocale(): void {
  document.documentElement.lang = getLocale();
}

/**
 * Translate an English text. Placeholders like {name} are replaced from params. Unknown texts stay English, so a
 * missing translation never hides information.
 */
export function t(text: string, params?: Record<string, string | number>): string {
  const base = getLocale() === 'de' ? (de[text] ?? text) : text;
  if (!params) return base;
  return base.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Translate an optional label from the server (node parameters, credential fields) */
export function tl<T extends string | undefined>(text: T): T {
  return (text === undefined ? text : t(text)) as T;
}

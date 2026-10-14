// Farbschema: dunkel (Standard) oder hell, als data-theme am Wurzelelement. Gilt pro Browser (localStorage).
export type Theme = 'dark' | 'light';

const KEY = 'filuflow.theme';

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme = getTheme()): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#FFFFFF' : '#0B1219');
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Speicher nicht verfügbar: gilt nur bis zum Neuladen
  }
  applyTheme(theme);
}

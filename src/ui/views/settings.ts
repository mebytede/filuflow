// Einstellungen der Oberfläche (Einzelbetrieb): Farbschema, Abmelden.
import { h } from '../dom.js';
import { button, pageHead } from '../shell.js';
import { getTheme, setTheme, type Theme } from '../theme.js';

/** Auswahl des Farbschemas (dunkel ist Standard); gilt für diesen Browser */
export function themeChooser(): HTMLElement {
  const box = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Farbschema' });
  const render = () => {
    const current = getTheme();
    box.replaceChildren(
      ...([['dark', 'Dunkel'], ['light', 'Hell']] as Array<[Theme, string]>).map(([value, text]) =>
        h('button', { type: 'button', class: current === value ? 'on' : '', 'aria-pressed': String(current === value), onclick: () => (setTheme(value), render()) }, text),
      ),
    );
  };
  render();
  return box;
}

export function settingsView(logout: () => void): HTMLElement {
  return h(
    'section',
    { class: 'page page-narrow' },
    pageHead('Einstellungen', 'Oberfläche'),
    h('div', { class: 'field' }, h('span', null, 'Farbschema'), h('div', null, themeChooser()), h('span', { class: 'muted small' }, 'Gilt für diesen Browser.')),
    h(
      'div',
      { class: 'field' },
      h('span', null, 'Anmeldung'),
      h('p', { class: 'muted', style: { margin: '0 0 8px' } }, 'Der API-Key liegt im Speicher dieses Browsers. Abmelden entfernt ihn.'),
      h('div', null, button('Abmelden', { icon: 'log-out', onclick: logout })),
    ),
  );
}

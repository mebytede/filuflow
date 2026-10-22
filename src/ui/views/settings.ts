// Interface settings (standalone mode): color scheme, language, log out.
import { h } from '../dom.js';
import { button, pageHead } from '../shell.js';
import { getTheme, setTheme, type Theme } from '../theme.js';
import { getLocale, setLocale, t, type Locale } from '../i18n.js';

/** Color scheme chooser (dark is the default); applies to this browser */
export function themeChooser(): HTMLElement {
  const box = h('div', { class: 'segmented', role: 'group', 'aria-label': t('Color scheme') });
  const render = () => {
    const current = getTheme();
    box.replaceChildren(
      ...([['dark', t('Dark')], ['light', t('Light')]] as Array<[Theme, string]>).map(([value, text]) =>
        h('button', { type: 'button', class: current === value ? 'on' : '', 'aria-pressed': String(current === value), onclick: () => (setTheme(value), render()) }, text),
      ),
    );
  };
  render();
  return box;
}

/** Language chooser (English is the default); applies to this browser, the page reloads. Labels are not translated. */
export function localeChooser(): HTMLElement {
  const current = getLocale();
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('Language') },
    ...([['en', 'English'], ['de', 'Deutsch']] as Array<[Locale, string]>).map(([value, text]) =>
      h('button', { type: 'button', class: current === value ? 'on' : '', 'aria-pressed': String(current === value), onclick: () => setLocale(value) }, text),
    ),
  );
}

export function settingsView(logout: () => void): HTMLElement {
  return h(
    'section',
    { class: 'page page-narrow' },
    pageHead(t('Settings'), t('Interface')),
    h('div', { class: 'field' }, h('span', null, t('Color scheme')), h('div', null, themeChooser()), h('span', { class: 'muted small' }, t('Applies to this browser.'))),
    h('div', { class: 'field' }, h('span', null, t('Language')), h('div', null, localeChooser()), h('span', { class: 'muted small' }, t('Applies to this browser.'))),
    h(
      'div',
      { class: 'field' },
      h('span', null, t('Login')),
      h('p', { class: 'muted', style: { margin: '0 0 8px' } }, t("The API key is stored in this browser's storage. Logging out removes it.")),
      h('div', null, button(t('Log out'), { icon: 'log-out', onclick: logout })),
    ),
  );
}

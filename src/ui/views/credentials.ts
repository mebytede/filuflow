// Credentials: nur Name, ID und Typ (Werte verlassen den Server nicht).
import { api } from '../api.js';
import { h } from '../dom.js';
import { pageHead } from '../shell.js';

export async function credentialsView(): Promise<HTMLElement> {
  const list = await api.credentials();
  return h(
    'section',
    { class: 'page' },
    pageHead('Credentials', 'Zugangsdaten dieser Instanz'),
    h(
      'p',
      { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } },
      'Credentials stehen in credentials.json (bzw. FILUFLOW_CREDENTIALS) auf dem Server und werden dort gepflegt, optional verschlüsselt mit "filuflow credentials encrypt". Die Oberfläche zeigt nur Namen und Typen.',
    ),
    list.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'list-table' },
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Typ'), h('th', null, 'ID'))),
            h('tbody', null, list.map((c) => h('tr', null, h('td', { class: 'cell-name' }, c.name), h('td', { class: 'mono' }, c.type ?? ''), h('td', { class: 'mono muted' }, c.id ?? '')))),
          ),
        )
      : h('div', { class: 'empty' }, h('p', null, 'Keine Credentials geladen.')),
  );
}

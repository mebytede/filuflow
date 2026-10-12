// Credentials: nur Name, ID und Typ (Werte verlassen den Server nicht).
import { api } from '../api.js';
import { h } from '../dom.js';

export async function credentialsView(): Promise<HTMLElement> {
  const list = await api.credentials();
  return h(
    'section',
    { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Credentials')),
    h(
      'p',
      { class: 'muted' },
      'Credentials stehen in credentials.json (bzw. FILUFLOW_CREDENTIALS) auf dem Server und werden dort gepflegt, optional verschlüsselt mit "filuflow credentials encrypt". Die Oberfläche zeigt nur Namen und Typen.',
    ),
    list.length
      ? h(
          'div',
          { class: 'table-wrap card' },
          h(
            'table',
            { class: 'list-table' },
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Typ'), h('th', null, 'ID'))),
            h('tbody', null, list.map((c) => h('tr', null, h('td', { class: 'strong' }, c.name), h('td', null, h('code', null, c.type ?? '')), h('td', { class: 'muted' }, c.id ?? '')))),
          ),
        )
      : h('div', { class: 'empty' }, h('p', null, 'Keine Credentials geladen.')),
  );
}

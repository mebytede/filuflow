// Anzeige von Items (Ergebnis eines Node-Laufs): Tabelle oder JSON.
import { h } from '../dom.js';
import type { Item } from '../types.js';

function cell(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function itemsView(items: Item[], mode: 'table' | 'json'): HTMLElement {
  if (!items.length) return h('p', { class: 'muted' }, 'Keine Items');
  if (mode === 'json') {
    const view = items.map((i) => {
      const out: Record<string, unknown> = { json: i.json };
      if (i.binary) out.binary = i.binary;
      if (i.error) out.error = i.error;
      return out;
    });
    return h('pre', { class: 'json-view' }, JSON.stringify(view, null, 2));
  }
  const columns: string[] = [];
  for (const item of items) for (const k of Object.keys(item.json ?? {})) if (!columns.includes(k)) columns.push(k);
  const hasBinary = items.some((i) => i.binary);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, '#'), columns.map((c) => h('th', null, c)), hasBinary && h('th', null, 'Binär'))),
      h(
        'tbody',
        null,
        items.map((item, i) =>
          h(
            'tr',
            null,
            h('td', { class: 'muted' }, String(i + 1)),
            columns.map((c) => {
              const text = cell(item.json?.[c]);
              return h('td', { title: text.length > 80 ? text : undefined }, text.length > 200 ? `${text.slice(0, 199)}…` : text);
            }),
            hasBinary &&
              h(
                'td',
                null,
                Object.entries(item.binary ?? {})
                  .map(([k, b]) => `${k}: ${b.fileName ?? ''} (${b.mimeType ?? ''}${b.fileSize ? `, ${b.fileSize}` : ''})`)
                  .join(', '),
              ),
          ),
        ),
      ),
    ),
  );
}

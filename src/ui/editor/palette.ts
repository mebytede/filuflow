// Node-Palette: Suche und Gruppen; Klick fügt ein, Ziehen legt auf dem Canvas ab.
import { appendAll, h } from '../dom.js';
import type { NodeTypeInfo } from '../types.js';

const GROUP_ORDER = ['Trigger', 'Kern', 'KI', 'KI: Sub-Nodes', 'Sonstiges'];

export function palette(types: NodeTypeInfo[], onAdd: (type: string) => void): HTMLElement {
  const search = h('input', { type: 'search', class: 'palette-search', placeholder: 'Node suchen …', 'aria-label': 'Node suchen' });
  const list = h('div', { class: 'palette-list' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const matches = types.filter((t) => !q || t.displayName.toLowerCase().includes(q) || t.type.toLowerCase().includes(q));
    for (const group of GROUP_ORDER) {
      const inGroup = matches.filter((t) => t.group === group).sort((a, b) => a.displayName.localeCompare(b.displayName));
      if (!inGroup.length) continue;
      appendAll(
        list,
        h('div', { class: 'palette-group' }, group),
        inGroup.map((t) =>
          h(
            'button',
            {
              type: 'button',
              class: `palette-item group-${group.replace(/[^A-Za-z]/g, '').toLowerCase()}`,
              draggable: 'true',
              title: `${t.type} (v${t.versions.join(', v')})`,
              onclick: () => onAdd(t.type),
              ondragstart: (e: DragEvent) => {
                e.dataTransfer?.setData('application/x-filuflow-node', t.type);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
              },
            },
            h('span', { class: 'palette-dot' }),
            t.displayName,
          ),
        ),
      );
    }
    if (!list.childElementCount) list.append(h('p', { class: 'muted' }, 'Nichts gefunden'));
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') list.querySelector<HTMLButtonElement>('.palette-item')?.click();
  });
  render();
  return h('aside', { class: 'palette', 'aria-label': 'Nodes' }, search, list);
}

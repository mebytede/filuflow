// Node picker: opens from the "Nodes" button at the top left of the canvas. Search and groups; a click inserts,
// dragging drops onto the canvas.
import { appendAll, h } from '../dom.js';
import { t as tr, tl } from '../i18n.js';
import type { NodeTypeInfo } from '../types.js';
import { icon } from '../icons.js';
import { iconButton } from '../shell.js';
import { nodeLook } from './nodeStyle.js';

const GROUP_ORDER = ['Trigger', 'Core', 'Services', 'AI', 'AI: Sub-nodes', 'Extensions', 'Other'];

export function palette(types: NodeTypeInfo[], onAdd: (type: string) => void, onClose: () => void): HTMLElement {
  const search = h('input', { type: 'search', class: 'palette-search', placeholder: tr('Search nodes'), 'aria-label': tr('Search nodes') });
  const list = h('div', { class: 'palette-list' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const matches = types.filter((t) => !q || t.displayName.toLowerCase().includes(q) || t.type.toLowerCase().includes(q));
    // Unknown groups (e.g. from plugins) before "Other"
    const extra = [...new Set(matches.map((t) => t.group).filter((g) => !GROUP_ORDER.includes(g)))].sort();
    const order = [...GROUP_ORDER.slice(0, -1), ...extra, GROUP_ORDER[GROUP_ORDER.length - 1]];
    for (const group of order) {
      const inGroup = matches.filter((t) => t.group === group).sort((a, b) => a.displayName.localeCompare(b.displayName));
      if (!inGroup.length) continue;
      appendAll(
        list,
        h('div', { class: 'palette-group' }, tl(group)),
        inGroup.map((t) =>
          h(
            'button',
            {
              type: 'button',
              class: 'palette-item',
              draggable: 'true',
              title: `${t.type} (v${t.versions.join(', v')})`,
              onclick: () => onAdd(t.type),
              ondragstart: (e: DragEvent) => {
                e.dataTransfer?.setData('application/x-filuflow-node', t.type);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
              },
            },
            icon(nodeLook(t.type, t).icon, 16),
            t.displayName,
          ),
        ),
      );
    }
    if (!list.childElementCount) list.append(h('p', { class: 'muted', style: { padding: '0 16px' } }, tr('Nothing found.')));
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') list.querySelector<HTMLButtonElement>('.palette-item')?.click();
    if (e.key === 'Escape') onClose();
  });
  render();
  return h('aside', { class: 'palette', 'aria-label': tr('Nodes') }, h('div', { class: 'palette-head' }, search, iconButton('x', tr('Close'), onClose)), list);
}

// M19: Parameterbeschreibungen je Knotentyp. Struktur, Sichtbarkeitsregeln, Defaults und Abdeckung aller Parameter,
// die in den Fixture-Workflows (exportiert aus n8n) vorkommen.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultRegistry } from '../src/nodes/index.js';
import type { ParamSchema } from '../src/nodes/params.js';
import type { Workflow } from '../src/types.js';
import { visibleDefs, visibleParameterNames } from '../src/ui/editor/schemaVisibility.js';

const registry = getDefaultRegistry();
const types = registry.list();

function walk(defs: ParamSchema[], visit: (def: ParamSchema, siblings: ParamSchema[], path: string) => void, path = ''): void {
  for (const def of defs) {
    visit(def, defs, `${path}${def.name}`);
    if (def.children) walk(def.children, visit, `${path}${def.name}.`);
    for (const g of def.groups ?? []) walk(g.children, visit, `${path}${def.name}.${g.name}.`);
  }
}

describe('Parameterbeschreibungen', () => {
  it('gibt es für jeden Knotentyp', () => {
    const missing = types.filter((t) => !t.parameters).map((t) => t.type);
    expect(missing).toEqual([]);
  });

  it('sind strukturell gültig', () => {
    const problems: string[] = [];
    for (const t of types) {
      walk(t.parameters ?? [], (def, siblings, path) => {
        const where = `${t.type} ${path}`;
        if (!def.name || !def.label || !def.type) problems.push(`${where}: name, label oder type fehlt`);
        if (/—/.test(`${def.label} ${def.description ?? ''} ${def.placeholder ?? ''}`)) problems.push(`${where}: Gedankenstrich`);
        if ((def.type === 'options' || def.type === 'multiOptions') && !def.options?.length) problems.push(`${where}: options ohne Liste`);
        if (def.type === 'options' && def.default !== undefined && def.default !== '' && !(typeof def.default === 'string' && def.default.startsWith('=')) && def.options && !def.options.some((o) => o.value === def.default)) {
          problems.push(`${where}: Default ${JSON.stringify(def.default)} nicht in den Optionen`);
        }
        if (def.type === 'fixedCollection' && !def.groups?.length) problems.push(`${where}: fixedCollection ohne Gruppen`);
        if (def.type === 'collection' && !def.children) problems.push(`${where}: collection ohne children`);
        for (const rule of [def.show, def.hide]) {
          for (const key of Object.keys(rule ?? {})) {
            if (key === '@version') continue;
            if (key.startsWith('/')) {
              if (!(t.parameters ?? []).some((d) => d.name === key.slice(1).split('.')[0])) problems.push(`${where}: Regel auf unbekannten Parameter "${key}"`);
              continue;
            }
            if (!siblings.some((s) => s.name === key)) problems.push(`${where}: Regel auf unbekannten Parameter "${key}"`);
          }
        }
        if (def.options) {
          const values = def.options.map((o) => o.value);
          if (new Set(values).size !== values.length) problems.push(`${where}: doppelte Optionswerte`);
        }
      });
      for (const def of t.parameters ?? []) {
        for (const key of Object.keys(def.show ?? {}).filter((k) => k.startsWith('/'))) {
          if (!(t.parameters ?? []).some((d) => d.name === key.slice(1).split('.')[0])) problems.push(`${t.type} ${def.name}: Regel auf unbekannten Parameter "${key}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('kennt alle Parameter der Fixture-Workflows (aus n8n exportiert)', () => {
    const dir = join(import.meta.dirname, '..', 'fixtures');
    const problems: string[] = [];
    let checked = 0;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'workflow.json');
      if (!existsSync(file)) continue;
      const wf = JSON.parse(readFileSync(file, 'utf8')) as Workflow;
      for (const node of wf.nodes) {
        const t = registry.getVersioned(node.type, node.typeVersion);
        if (!t?.parameters) continue;
        const known = new Set(t.parameters.map((d) => d.name));
        for (const key of Object.keys(node.parameters ?? {})) {
          checked++;
          if (!known.has(key)) problems.push(`${name}: ${node.type} v${node.typeVersion} "${key}" fehlt in der Beschreibung`);
        }
        // Gesetzte Parameter sind für diese Version sichtbar (sonst zeigt das Formular sie nicht)
        const visible = new Set(visibleParameterNames(node.parameters ?? {}, t.parameters, node.typeVersion));
        for (const key of Object.keys(node.parameters ?? {})) {
          if (known.has(key) && !visible.has(key)) problems.push(`${name}: ${node.type} v${node.typeVersion} "${key}" ist gesetzt, aber im Formular unsichtbar`);
        }
        // Werte von Auswahlfeldern stehen in den Optionen der sichtbaren Definition
        const root = { values: node.parameters ?? {}, defs: t.parameters };
        for (const def of visibleDefs(root, root, node.typeVersion)) {
          const v = node.parameters?.[def.name];
          if (v === undefined || (typeof v === 'string' && v.startsWith('='))) continue;
          const allowed = (def.options ?? []).map((o) => o.value);
          // fixtures/12-data-nodes setzt dateTime "to" von Hand auf "day"; n8n bietet nur "month" an
          if (node.type === 'n8n-nodes-base.dateTime' && def.name === 'to' && v === 'day') continue;
          if (def.type === 'options' && !allowed.includes(v as string)) problems.push(`${name}: ${node.type} "${def.name}" = ${JSON.stringify(v)} nicht in den Optionen`);
          if (def.type === 'multiOptions' && (!Array.isArray(v) || v.some((x) => !allowed.includes(x as string)))) problems.push(`${name}: ${node.type} "${def.name}" = ${JSON.stringify(v)} nicht in den Optionen`);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect([...new Set(problems)]).toEqual([]);
  });

  it('Sichtbarkeit wie n8n: show, hide, @version, Expressions', () => {
    const schema: ParamSchema[] = [
      { name: 'mode', label: 'Modus', type: 'options', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { name: 'nurA', label: 'Nur A', type: 'string', default: '', show: { mode: ['a'] } },
      { name: 'nichtB', label: 'Nicht B', type: 'string', default: '', hide: { mode: ['b'] } },
      { name: 'neu', label: 'Ab v2', type: 'string', default: '', show: { '@version': [{ _cnd: { gte: 2 } }] } },
      { name: 'feld', label: 'Feld v1', type: 'number', default: 1, show: { '@version': [1] } },
      { name: 'feld', label: 'Feld v2', type: 'string', default: 'x', show: { '@version': [{ _cnd: { gte: 2 } }] } },
    ];
    expect(visibleParameterNames({}, schema, 1)).toEqual(['mode', 'nurA', 'nichtB', 'feld']);
    expect(visibleParameterNames({ mode: 'b' }, schema, 2)).toEqual(['mode', 'neu', 'feld']);
    // Expression im steuernden Parameter: abhängige Felder bleiben sichtbar
    expect(visibleParameterNames({ mode: '={{ "b" }}' }, schema, 1)).toEqual(['mode', 'nurA', 'nichtB', 'feld']);
  });
});

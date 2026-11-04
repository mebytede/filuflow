// M19: parameter descriptions per node type. Structure, visibility rules, defaults and coverage of all parameters
// that appear in the fixture workflows (exported from the reference).
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

describe('Parameter descriptions', () => {
  it('exist for every node type', () => {
    const missing = types.filter((t) => !t.parameters).map((t) => t.type);
    expect(missing).toEqual([]);
  });

  it('are structurally valid', () => {
    const problems: string[] = [];
    for (const t of types) {
      walk(t.parameters ?? [], (def, siblings, path) => {
        const where = `${t.type} ${path}`;
        if (!def.name || !def.label || !def.type) problems.push(`${where}: name, label or type missing`);
        if (/\u2014/.test(`${def.label} ${def.description ?? ''} ${def.placeholder ?? ''}`)) problems.push(`${where}: em dash`);
        if ((def.type === 'options' || def.type === 'multiOptions') && !def.options?.length && !def.loadOptions) problems.push(`${where}: options without a list`);
        if (def.loadOptions && def.type !== 'options' && def.type !== 'multiOptions') problems.push(`${where}: loadOptions on a ${def.type} field`);
        if (def.type === 'options' && def.default !== undefined && def.default !== '' && !(typeof def.default === 'string' && def.default.startsWith('=')) && def.options && !def.options.some((o) => o.value === def.default)) {
          problems.push(`${where}: Default ${JSON.stringify(def.default)} not in the options`);
        }
        if (def.type === 'fixedCollection' && !def.groups?.length) problems.push(`${where}: fixedCollection without groups`);
        if (def.type === 'collection' && !def.children) problems.push(`${where}: collection without children`);
        for (const rule of [def.show, def.hide]) {
          for (const key of Object.keys(rule ?? {})) {
            if (key === '@version') continue;
            if (key.startsWith('/')) {
              if (!(t.parameters ?? []).some((d) => d.name === key.slice(1).split('.')[0])) problems.push(`${where}: rule on unknown parameter "${key}"`);
              continue;
            }
            if (!siblings.some((s) => s.name === key)) problems.push(`${where}: rule on unknown parameter "${key}"`);
          }
        }
        if (def.options) {
          const values = def.options.map((o) => o.value);
          if (new Set(values).size !== values.length) problems.push(`${where}: duplicate option values`);
        }
      });
      for (const def of t.parameters ?? []) {
        for (const key of Object.keys(def.show ?? {}).filter((k) => k.startsWith('/'))) {
          if (!(t.parameters ?? []).some((d) => d.name === key.slice(1).split('.')[0])) problems.push(`${t.type} ${def.name}: rule on unknown parameter "${key}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('dynamic option lists (M47a): every method exists on the node type and dependsOn names existing parameters', () => {
    const problems: string[] = [];
    let found = 0;
    for (const t of types) {
      walk(t.parameters ?? [], (def, siblings, path) => {
        const where = `${t.type} ${path}`;
        if (def.loadOptions) {
          found++;
          const table = t.methods?.loadOptions;
          if (!table || !Object.prototype.hasOwnProperty.call(table, def.loadOptions.method) || typeof table[def.loadOptions.method] !== 'function') {
            problems.push(`${where}: loadOptions method "${def.loadOptions.method}" missing in methods.loadOptions`);
          }
          for (const dep of def.loadOptions.dependsOn ?? []) {
            const ok = dep.startsWith('&')
              ? siblings.some((s) => s.name === dep.slice(1))
              : (t.parameters ?? []).some((d) => d.name === dep.replace(/^\//, '').split('.')[0]);
            if (!ok) problems.push(`${where}: dependsOn "${dep}" names no parameter`);
          }
        }
        for (const mode of def.modes ?? []) {
          if (!mode.searchListMethod) continue;
          found++;
          const table = t.methods?.listSearch;
          if (!table || !Object.prototype.hasOwnProperty.call(table, mode.searchListMethod)) problems.push(`${where}: searchListMethod "${mode.searchListMethod}" missing in methods.listSearch`);
        }
      });
    }
    expect(found).toBeGreaterThanOrEqual(19);
    expect(problems).toEqual([]);
  });

  it('resource locator modes (M47b): list sources, extractValue with exactly one group, valid validation rules', () => {
    const problems: string[] = [];
    let pickers = 0;
    for (const t of types) {
      walk(t.parameters ?? [], (def, _siblings, path) => {
        const where = `${t.type} ${path}`;
        if (def.modes && def.type !== 'resourceLocator') problems.push(`${where}: modes on a ${def.type} field`);
        for (const mode of def.modes ?? []) {
          const m = `${where} mode ${mode.name}`;
          if (mode.type === 'list' && !mode.searchListMethod && !mode.listSource) problems.push(`${m}: list mode without searchListMethod or listSource`);
          if ((mode.searchListMethod || mode.listSource || mode.searchable || mode.searchFilterRequired) && mode.type !== 'list') problems.push(`${m}: list options on a mode of type ${mode.type}`);
          if (mode.listSource) {
            pickers++;
            if (mode.listSource !== 'workflows') problems.push(`${m}: unknown listSource`);
          }
          if (mode.searchListMethod && typeof t.methods?.listSearch?.[mode.searchListMethod] !== 'function') problems.push(`${m}: searchListMethod is not a function`);
          if (mode.extractValue) {
            try {
              const groups = (new RegExp(`${mode.extractValue.regex}|`).exec('') ?? []).length - 1;
              if (groups !== 1) problems.push(`${m}: extractValue needs exactly one group, has ${groups}`);
            } catch {
              problems.push(`${m}: extractValue regex does not compile`);
            }
          }
          for (const rule of mode.validation ?? []) {
            if (!rule.errorMessage) problems.push(`${m}: validation without errorMessage`);
            try {
              new RegExp(rule.regex);
            } catch {
              problems.push(`${m}: validation regex does not compile`);
            }
          }
        }
      });
    }
    expect(pickers).toBe(2);
    expect(problems).toEqual([]);
  });

  it('knows all parameters of the fixture workflows (exported from the reference)', () => {
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
          if (!known.has(key)) problems.push(`${name}: ${node.type} v${node.typeVersion} "${key}" missing in the description`);
        }
        // Set parameters are visible for this version (otherwise the form does not show them)
        const visible = new Set(visibleParameterNames(node.parameters ?? {}, t.parameters, node.typeVersion));
        for (const key of Object.keys(node.parameters ?? {})) {
          if (known.has(key) && !visible.has(key)) problems.push(`${name}: ${node.type} v${node.typeVersion} "${key}" is set but invisible in the form`);
        }
        // Values of option fields are in the options of the visible definition
        const root = { values: node.parameters ?? {}, defs: t.parameters };
        for (const def of visibleDefs(root, root, node.typeVersion)) {
          const v = node.parameters?.[def.name];
          if (v === undefined || (typeof v === 'string' && v.startsWith('='))) continue;
          // Loaded lists are only known at runtime
          if (def.loadOptions) continue;
          const allowed = (def.options ?? []).map((o) => o.value);
          // fixtures/12-data-nodes sets dateTime "to" to "day" by hand; the reference only offers "month"
          if (node.type === 'n8n-nodes-base.dateTime' && def.name === 'to' && v === 'day') continue;
          if (def.type === 'options' && !allowed.includes(v as string)) problems.push(`${name}: ${node.type} "${def.name}" = ${JSON.stringify(v)} not in the options`);
          if (def.type === 'multiOptions' && (!Array.isArray(v) || v.some((x) => !allowed.includes(x as string)))) problems.push(`${name}: ${node.type} "${def.name}" = ${JSON.stringify(v)} not in the options`);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect([...new Set(problems)]).toEqual([]);
  });

  it('visibility like the reference: show, hide, @version, expressions', () => {
    const schema: ParamSchema[] = [
      { name: 'mode', label: 'Mode', type: 'options', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { name: 'onlyA', label: 'Only A', type: 'string', default: '', show: { mode: ['a'] } },
      { name: 'notB', label: 'Not B', type: 'string', default: '', hide: { mode: ['b'] } },
      { name: 'new', label: 'From v2', type: 'string', default: '', show: { '@version': [{ _cnd: { gte: 2 } }] } },
      { name: 'field', label: 'Field v1', type: 'number', default: 1, show: { '@version': [1] } },
      { name: 'field', label: 'Field v2', type: 'string', default: 'x', show: { '@version': [{ _cnd: { gte: 2 } }] } },
    ];
    expect(visibleParameterNames({}, schema, 1)).toEqual(['mode', 'onlyA', 'notB', 'field']);
    expect(visibleParameterNames({ mode: 'b' }, schema, 2)).toEqual(['mode', 'new', 'field']);
    // Expression in the controlling parameter: dependent fields stay visible
    expect(visibleParameterNames({ mode: '={{ "b" }}' }, schema, 1)).toEqual(['mode', 'onlyA', 'notB', 'field']);
  });
});

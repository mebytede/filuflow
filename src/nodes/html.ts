// HTML, n8n-nodes-base.html (typeVersion 1, 1.1, 1.2)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Html (Html.node.ts, utils.ts)
import * as cheerio from 'cheerio';
import { convert } from 'html-to-text';
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { getResolvables, sanitizeDataPathKey } from './shared/utils.js';

interface ValueData {
  key: string;
  cssSelector: string;
  returnValue: string;
  attribute?: string;
  skipSelectors?: string;
  returnArray?: boolean;
}

// cheerio-Auswahl; die Typen der rc-Version sind unhandlich
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cheerio 1.0.0-rc.6 Selection
type Sel = any;

const PLACEHOLDER = `<!DOCTYPE html>

<html>
<head>
  <meta charset="UTF-8" />
  <title>My HTML document</title>
</head>
<body>
  <div class="container">
    <h1>This is an H1 heading</h1>
    <h2>This is an H2 heading</h2>
    <p>This is a paragraph</p>
  </div>
</body>
</html>

<style>
.container {
  background-color: #ffffff;
  text-align: center;
  padding: 16px;
  border-radius: 8px;
}

h1 {
  color: #ff6d5a;
  font-size: 24px;
  font-weight: bold;
  padding: 8px;
}

h2 {
  color: #909399;
  font-size: 18px;
  font-weight: bold;
  padding: 8px;
}
</style>

<script>
console.log("Hello World!");
</script>`;

function extract($el: Sel, v: ValueData, version: number): string | undefined {
  switch (v.returnValue ?? 'text') {
    case 'attribute':
      return $el.attr(v.attribute ?? '');
    case 'html':
      return $el.html() || undefined;
    case 'value':
      return $el.val();
    default: {
      if (version <= 1.1) return $el.text() || undefined;
      const html = $el.html() || '';
      const options = v.skipSelectors
        ? { selectors: v.skipSelectors.split(',').map((s) => ({ selector: s.trim(), format: 'skip' })) }
        : undefined;
      return convert(html, options);
    }
  }
}

function getValue($el: Sel, v: ValueData, options: Record<string, unknown>, version: number): string | undefined {
  let value = extract($el, v, version);
  if (value === undefined) return value;
  if (options.trimValues ?? true) value = value.trim();
  if (options.cleanUpText ?? true) {
    value = value.replace(/^\s+|\s+$/g, '').replace(/(\r\n|\n|\r)/gm, '').replace(/\s+/g, ' ');
  }
  return value;
}

const capitalizeHeader = (header: string, capitalize?: boolean) =>
  !capitalize
    ? header
    : header
        .split('_')
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');

export const htmlNode: NodeType = {
  type: 'n8n-nodes-base.html',
  displayName: 'HTML',
  versions: [1, 1.1, 1.2],
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    const operation = ctx.getParam<string>('operation', 0, 'generateHtmlTemplate');
    const version = ctx.node.typeVersion;
    if (operation === 'convertToHtmlTable' && items.length) {
      const options = ctx.getParam<Record<string, unknown>>('options', 0, {});
      let tableStyle = '';
      let headerStyle = '';
      let cellStyle = '';
      if (!options.customStyling) {
        tableStyle = "style='border-spacing:0; font-family:helvetica,arial,sans-serif'";
        headerStyle = "style='margin:0; padding:7px 20px 7px 0px; border-bottom:1px solid #eee; text-align:left; color:#888; font-weight:normal'";
        cellStyle = "style='margin:0; padding:7px 20px 7px 0px; border-bottom:1px solid #eee'";
      }
      const keys = new Set<string>();
      for (const e of items) for (const k of Object.keys(e.json)) keys.add(k);
      const headers = [...keys];
      let table = `<table ${tableStyle} ${String(options.tableAttributes || '')}>`;
      if (options.caption) table += `<caption>${String(options.caption)}</caption>`;
      table += `<thead ${headerStyle} ${String(options.headerAttributes || '')}>`;
      table += '<tr>' + headers.map((h) => '<th>' + capitalizeHeader(h, options.capitalize as boolean) + '</th>').join('') + '</tr>';
      table += '</thead><tbody>';
      items.forEach((entry, i) => {
        table += `<tr  ${ctx.getParam<string>('options.rowAttributes', i, '')}>`;
        const cellAttrs = ctx.getParam<string>('options.cellAttributes', i, '');
        table += headers
          .map((h) => {
            const v = entry.json[h];
            return `<td ${cellStyle} ${cellAttrs}>` + (typeof v === 'boolean' ? `<input type="checkbox" ${v ? 'checked="checked"' : ''}/>` : String(v)) + '</td>';
          })
          .join('');
        table += '</tr>';
      });
      table += '</tbody></table>';
      return [[{ json: { table }, pairedItem: items.map((_i, index) => ({ item: index })) }]];
    }
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        if (operation === 'generateHtmlTemplate') {
          let html = ctx.getParam<string>('html', i, PLACEHOLDER);
          for (const r of getResolvables(html)) html = html.replace(r, String(ctx.evaluateExpression(r, i)));
          out.push({ json: { html }, pairedItem: { item: i } });
        } else if (operation === 'extractHtmlContent') {
          const dataPropertyName = ctx.getParam<string>('dataPropertyName', i, 'data');
          const extraction = ctx.getParam<{ values?: ValueData[] }>('extractionValues', i, {});
          const options = ctx.getParam<Record<string, unknown>>('options', i, {});
          const sourceData = ctx.getParam<string>('sourceData', i, 'json');
          const item = items[i];
          let htmlArray: unknown;
          if (sourceData === 'json') {
            const value = version === 1 ? item.json[sanitizeDataPathKey(item.json, dataPropertyName)] : lodash.get(item.json, dataPropertyName);
            if (value === undefined) throw new NodeOperationError(ctx.node.name, `No property named "${dataPropertyName}" exists!`, { itemIndex: i });
            htmlArray = value;
          } else {
            const ref = item.binary?.[dataPropertyName];
            if (!ref) throw new NodeOperationError(ctx.node.name, `This operation expects the node's input data to contain a binary file '${dataPropertyName}', but none was found [item ${i}]`, { itemIndex: i });
            htmlArray = (await ctx.helpers.binary.getBuffer(ref)).toString('utf-8');
          }
          const list = Array.isArray(htmlArray) ? htmlArray : [htmlArray];
          for (const html of list) {
            const $ = cheerio.load(html as string);
            const newItem: Item = { json: {}, pairedItem: { item: i } };
            for (const v of extraction.values ?? []) {
              const el = $(v.cssSelector ?? '');
              if (v.returnArray) {
                const arr: Array<string | undefined> = [];
                el.each((_idx: number, node: unknown) => {
                  arr.push(getValue($(node as never), v, options, version));
                });
                newItem.json[v.key ?? ''] = arr;
              } else {
                newItem.json[v.key ?? ''] = getValue(el, v, options, version);
              }
            }
            out.push(newItem);
          }
        }
      } catch (error) {
        if (ctx.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw error;
      }
    }
    return [out];
  },
};

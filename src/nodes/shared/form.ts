// Forms (Form Trigger, Form node, Wait "On Form Submitted").
// Behavior after the reference version 1.123.0, packages/nodes-base/nodes/Form/utils/utils.ts (prepareFormData, prepareFormReturnItem,
// addFormResponseDataToReturnItem, sanitizeHtml, formWebhook), Form/common.descriptions.ts (field types, defaults) and
// utils/formCompletionUtils.ts. The pages are our own implementation: plain HTML forms (multipart/form-data),
// without script; the reference uses a template with JavaScript. The field names field-0, field-1 … and the output are the same.
import { DateTime } from 'luxon';
import type { Item } from '../../types.js';
import type { BinaryStore } from '../../binary.js';

export const FORM_TRIGGER_TYPE = 'n8n-nodes-base.formTrigger';
export const FORM_NODE_TYPE = 'n8n-nodes-base.form';

export interface FormField {
  fieldLabel?: string;
  fieldName?: string;
  fieldType?: string;
  elementName?: string;
  placeholder?: string;
  defaultValue?: unknown;
  fieldValue?: string;
  fieldOptions?: { values?: Array<{ option: string }> };
  multiselect?: boolean;
  limitSelection?: string;
  numberOfSelections?: number;
  minSelections?: number;
  maxSelections?: number;
  html?: string;
  multipleFiles?: boolean;
  acceptFileTypes?: string;
  requiredField?: boolean;
  formatDate?: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// sanitizeHtml: allowed tags and attributes like the reference (sanitize-html), here as a small filter of our own
const ALLOWED_TAGS = new Set([
  'b', 'div', 'i', 'iframe', 'img', 'video', 'source', 'em', 'strong', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'u', 'sub', 'sup',
  'code', 'pre', 'span', 'br', 'ul', 'ol', 'li', 'p', 'table', 'thead', 'tbody', 'tfoot', 'td', 'tr', 'th',
]);
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  video: ['controls', 'autoplay', 'loop', 'muted', 'poster', 'width', 'height'],
  iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'referrerpolicy'],
  source: ['src', 'type'],
  td: ['colspan', 'rowspan', 'scope', 'headers'],
  th: ['colspan', 'rowspan', 'scope', 'headers'],
};
const URL_ATTRS = new Set(['href', 'src', 'poster']);
const VOID_TAGS = new Set(['br', 'img', 'source']);

/** Reduce HTML to allowed tags; everything else is output as text, scripts and styles are dropped */
export function sanitizeHtml(html: string): string {
  let out = '';
  const re = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/gi;
  let last = 0;
  for (const m of html.matchAll(re)) {
    out += esc(html.slice(last, m.index)).replace(/&amp;(#?\w+;)/g, '&$1');
    last = (m.index ?? 0) + m[0].length;
    if (m[1] || m[0].startsWith('<!--')) continue;
    const closing = m[2] === '/';
    const tag = m[3].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      if (!VOID_TAGS.has(tag)) out += `</${tag}>`;
      continue;
    }
    const attrs: string[] = [];
    for (const a of m[4].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const name = a[1].toLowerCase();
      if (!(ALLOWED_ATTRS[tag] ?? []).includes(name)) continue;
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      if (URL_ATTRS.has(name) && !/^https?:\/\//i.test(value.trim())) continue;
      attrs.push(`${name}="${esc(value)}"`);
    }
    // iframes always in a sandbox (reference: transformTags)
    if (tag === 'iframe') attrs.push('sandbox=""', 'referrerpolicy="strict-origin-when-cross-origin"');
    out += `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  }
  out += esc(html.slice(last)).replace(/&amp;(#?\w+;)/g, '&$1');
  return out;
}

/** Custom CSS without HTML (sanitizeCustomCss) */
export function sanitizeCss(css: string | undefined): string {
  return (css ?? '').replace(/<[^>]*>?/g, '');
}

export interface FormPage {
  title: string;
  description?: string;
  fields: FormField[];
  buttonLabel?: string;
  customCss?: string;
  /** Prefill from query parameters (field label) */
  query?: Record<string, unknown>;
  testRun?: boolean;
}

function shell(title: string, body: string, customCss?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || 'Form')}</title>
<link rel="stylesheet" href="/ui/form/form.css">
${customCss ? `<style>${sanitizeCss(customCss)}</style>` : ''}
</head>
<body>
<main class="form-card">
${body}
</main>
</body>
</html>`;
}

/** Page header: no script, own styles plus inline CSS; images and embedded pages only via http(s) */
export const FORM_CSP = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; media-src https: http:; frame-src https: http:; form-action 'self'; base-uri 'none'";

/** prepareFormData + template: form page as HTML */
export function renderFormPage(p: FormPage): string {
  const query = p.query ?? {};
  const fields = p.fields.map((field, index) => {
    const id = `field-${index}`;
    const type = field.fieldType ?? 'text';
    const label = field.fieldLabel ?? '';
    const required = field.requiredField === true;
    const fromQuery = label ? query[label] : undefined;
    const value = fromQuery ?? field.defaultValue ?? '';
    const req = required ? ' required' : '';
    const labelHtml = `<label class="form-label" for="${id}">${esc(label)}${required ? ' <span class="form-required">*</span>' : ''}</label>`;
    const options = field.fieldOptions?.values ?? [];
    if (type === 'html') return `<div class="form-html">${sanitizeHtml(String(field.html ?? ''))}</div>`;
    if (type === 'hiddenField') {
      const hiddenValue = value === '' ? (field.fieldValue ?? '') : value;
      return `<input type="hidden" name="${id}" value="${esc(hiddenValue)}">`;
    }
    if (type === 'checkbox' || type === 'radio' || field.multiselect) {
      const selected = new Set(String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      const inputType = type === 'radio' ? 'radio' : 'checkbox';
      const items = options
        .map((o, i) => {
          const oid = `option${i}_${id}`;
          // Required radio buttons are enforced by the browser; for checkboxes the server checks
          return `<label class="form-option" for="${oid}"><input type="${inputType}" id="${oid}" name="${id}" value="${esc(o.option)}"${selected.has(o.option) ? ' checked' : ''}${type === 'radio' && required ? ' required' : ''}> ${esc(o.option)}</label>`;
        })
        .join('');
      return `<fieldset class="form-field"><legend class="form-label">${esc(label)}${required ? ' <span class="form-required">*</span>' : ''}</legend>${items}</fieldset>`;
    }
    if (type === 'dropdown') {
      const opts = options.map((o) => `<option value="${esc(o.option)}"${o.option === value ? ' selected' : ''}>${esc(o.option)}</option>`).join('');
      return `<div class="form-field">${labelHtml}<select id="${id}" name="${id}"${req}><option value="">${esc(field.placeholder ?? '')}</option>${opts}</select></div>`;
    }
    if (type === 'textarea') {
      return `<div class="form-field">${labelHtml}<textarea id="${id}" name="${id}" rows="4" placeholder="${esc(field.placeholder ?? '')}"${req}>${esc(value)}</textarea></div>`;
    }
    if (type === 'file') {
      return `<div class="form-field">${labelHtml}<input type="file" id="${id}" name="${id}"${field.multipleFiles !== false ? ' multiple' : ''}${field.acceptFileTypes ? ` accept="${esc(field.acceptFileTypes)}"` : ''}${req}></div>`;
    }
    const inputType = ['number', 'date', 'email', 'password'].includes(type) ? type : 'text';
    return `<div class="form-field">${labelHtml}<input type="${inputType}" id="${id}" name="${id}" value="${esc(value)}" placeholder="${esc(field.placeholder ?? '')}"${inputType === 'number' ? ' step="any"' : ''}${req}></div>`;
  });
  const description = (p.description ?? '').replace(/\\n/g, '\n').replace(/<br>/g, '\n');
  const body = `${p.testRun ? '<p class="form-test">Test mode: the execution appears in the editor and in the list of executions.</p>' : ''}
<h1 class="form-title">${esc(p.title)}</h1>
${description ? `<div class="form-description">${sanitizeHtml(description).replace(/\n/g, '<br>')}</div>` : ''}
<form method="POST" enctype="multipart/form-data" class="form-fields">
${fields.join('\n')}
<button type="submit" class="form-submit">${esc(p.buttonLabel || 'Submit')}</button>
</form>`;
  return shell(p.title, body, p.customCss);
}

/** Completion page (form-trigger-completion) */
export function renderCompletionPage(p: { title: string; message?: string; formTitle?: string; customCss?: string; text?: string }): string {
  const body = p.text !== undefined && p.text !== ''
    ? `<div class="form-description">${esc(p.text).replace(/\n/g, '<br>')}</div>`
    : `<h1 class="form-title">${esc(p.title)}</h1>${p.message ? `<div class="form-description">${sanitizeHtml(p.message).replace(/\n/g, '<br>')}</div>` : ''}`;
  return shell(p.formTitle || p.title, body, p.customCss);
}

/** Check required checkboxes and selection limits (the reference checks in the browser); returns a message or undefined */
export function validateSubmission(fields: FormField[], form: FormData): string | undefined {
  for (const [index, field] of fields.entries()) {
    if (field.fieldType !== 'checkbox') continue;
    const count = form.getAll(`field-${index}`).length;
    const label = field.fieldLabel ?? `field-${index}`;
    if (field.requiredField && count === 0) return `"${label}" is a required field`;
    if (field.limitSelection === 'exact' && count && count !== (field.numberOfSelections ?? 1)) return `Select exactly ${field.numberOfSelections ?? 1} for "${label}"`;
    if (field.limitSelection === 'range' && count && (count < (field.minSelections ?? 0) || count > (field.maxSelections ?? 1))) {
      return `Select ${field.minSelections ?? 0} to ${field.maxSelections ?? 1} for "${label}"`;
    }
  }
  return undefined;
}

/**
 * prepareFormReturnItem and addFormResponseDataToReturnItem: fields field-N by label, numbers as numbers, text trimmed,
 * selections as a list (radio as a value), files as binary (label with _ instead of special characters), submittedAt, formMode.
 */
export async function formReturnItem(o: {
  fields: FormField[];
  form: FormData;
  mode: 'test' | 'production';
  timezone: string;
  binary: BinaryStore;
  query?: Record<string, unknown>;
}): Promise<Item> {
  const item: Item = { json: {} };
  const body: Record<string, unknown> = {};
  for (const [index, field] of o.fields.entries()) {
    const key = `field-${index}`;
    const all = o.form.getAll(key);
    const files = all.filter((v): v is Exclude<ReturnType<FormData['get']>, string | null> => typeof v !== 'string' && v.size > 0);
    const strings = all.filter((v): v is string => typeof v === 'string');
    if (field.fieldType === 'file') {
      if (!files.length) continue;
      item.binary ??= {};
      const multi = files.length > 1 || field.multipleFiles === true;
      const base = (field.fieldLabel ?? key).replace(/\W/g, '_');
      let count = 0;
      for (const file of files) {
        const name = multi ? `${base}_${count++}` : base;
        item.binary[name] = await o.binary.prepare(Buffer.from(await file.arrayBuffer()), file.name, file.type || undefined, { copy: true });
      }
      const meta = files.map((f) => ({ filename: f.name, mimetype: f.type || 'application/octet-stream', size: f.size }));
      body[key] = multi ? meta : meta[0];
      continue;
    }
    if (!strings.length) continue;
    body[key] = field.fieldType === 'checkbox' || field.multiselect ? strings : strings[0];
  }
  for (const [index, field] of o.fields.entries()) {
    const key = `field-${index}`;
    const name = field.fieldLabel ?? field.fieldName ?? key;
    let value = body[key] ?? null;
    if (value === null) {
      if (field.fieldType === 'html' && !field.elementName) continue;
      item.json[field.fieldType === 'html' ? (field.elementName as string) : name] = null;
      continue;
    }
    if (field.fieldType === 'html') {
      if (field.elementName) item.json[field.elementName] = value;
      continue;
    }
    if (field.fieldType === 'number') value = Number(value);
    if (field.fieldType === 'text') value = String(value).trim();
    if (field.fieldType === 'radio' && Array.isArray(value)) value = value[0];
    if (field.fieldType === 'file' && field.multipleFiles && !Array.isArray(value)) value = [value];
    item.json[name] = value;
  }
  item.json.submittedAt = DateTime.now().setZone(o.timezone).toISO();
  item.json.formMode = o.mode;
  if (o.query && Object.keys(o.query).length) item.json.formQueryParameters = o.query;
  return item;
}

/** Defaults of the parameter description (the reference adds them when loading the workflow): fieldType "text" */
function withDefaults(field: FormField): FormField {
  return { ...field, fieldType: field.fieldType ?? 'text' };
}

/** Fields of a node: formFields.values or (Form node) JSON definition */
export function formFieldsOf(parameters: Record<string, unknown>, resolveJson?: (raw: string) => unknown): FormField[] {
  if (parameters.defineForm === 'json') {
    const raw = parameters.jsonOutput;
    const value = typeof raw === 'string' ? (resolveJson ? resolveJson(raw) : JSON.parse(raw)) : raw;
    if (!Array.isArray(value)) throw new Error('Form fields must be an array');
    return (value as FormField[]).map(withDefaults);
  }
  const values = (parameters.formFields as { values?: FormField[] } | undefined)?.values;
  return Array.isArray(values) ? values.map(withDefaults) : [];
}

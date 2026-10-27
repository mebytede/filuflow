// Form for a credential (standalone mode and master). Fields follow the type description; free fields for custom
// types. Secret values never come back from the server: an empty field keeps the stored value.
import { dialog, h, toast } from '../dom.js';
import { iconButton } from '../shell.js';
import { t, tl } from '../i18n.js';
import type { CredentialDetail, CredentialField, CredentialInfo, CredentialSaveBody, CredentialTypeCatalog, CredentialTypeSchema } from '../types.js';

export interface CredentialFormBackend {
  types(): Promise<CredentialTypeCatalog>;
  get(name: string): Promise<CredentialDetail>;
  save(name: string, body: CredentialSaveBody): Promise<CredentialInfo>;
}

export interface CredentialFormOptions {
  /** edit an existing credential */
  name?: string;
  /** preset type (e.g. from the editor); cannot be changed */
  type?: string;
  /** note on where it is stored */
  note?: string;
  confirm?: string;
  /** Additional fields (e.g. worker selection in the master); collect returns parts of the save body or an error */
  extra?: { element: HTMLElement; collect(): Partial<CredentialSaveBody> | string };
}

const OTHER = '__other__';
const KEPT = (): string => t('stored, leave empty = unchanged');

function visible(schema: CredentialTypeSchema, field: CredentialField, values: Record<string, unknown>): boolean {
  if (!field.show) return true;
  return Object.entries(field.show).every(([key, allowed]) => {
    const dep = schema.fields.find((f) => f.name === key);
    const value = key in values ? values[key] : dep?.default;
    return allowed.includes(value as string | boolean);
  });
}

const isSecret = (f: CredentialField) => f.kind === 'password' || !!f.secret;

function fieldBox(label: string, input: HTMLElement, hint?: string, required?: boolean): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label, required ? ' *' : ''), input, hint ? h('span', { class: 'muted small' }, hint) : null);
}

/** Opens the form; returns the saved credential or null on cancel */
export async function credentialFormDialog(backend: CredentialFormBackend, o: CredentialFormOptions = {}): Promise<CredentialInfo | null> {
  const [catalog, detail] = await Promise.all([backend.types(), o.name ? backend.get(o.name) : Promise.resolve(undefined)]);
  const types = catalog.data;
  const secretsSet = new Set(detail?.secretsSet ?? []);
  const originalType = detail?.type ?? o.type;

  const nameInput = h('input', { type: 'text', class: 'param-input', value: detail?.name ?? '', placeholder: t('e.g. Customer API'), autocomplete: 'off', 'aria-label': t('Name') });
  const known = (name: string | undefined) => types.find((x) => x.name === name);
  const typeSelect = h(
    'select',
    { class: 'param-input', 'aria-label': t('Type'), disabled: !!o.type },
    types.map((ct) => h('option', { value: ct.name }, `${tl(ct.label)} (${ct.name})`)),
    h('option', { value: OTHER }, t('Other type')),
  );
  const otherType = h('input', { type: 'text', class: 'param-input', placeholder: t('Type name, e.g. slackApi'), 'aria-label': t('Other type') });
  if (originalType && known(originalType)) typeSelect.value = originalType;
  else if (originalType) {
    typeSelect.value = OTHER;
    otherType.value = originalType;
  } else typeSelect.value = types[0]?.name ?? OTHER;
  otherType.disabled = !!o.type;

  const description = h('p', { class: 'muted small', style: { margin: '-8px 0 16px' } });
  const fieldsBox = h('div');
  const otherBox = fieldBox(t('Type name'), otherType);

  // Current values per type (inputs are kept when switching back)
  const values: Record<string, unknown> = { ...(detail?.data ?? {}) };
  let collect: () => { data: Record<string, unknown>; keep: string[] } | string = () => ({ data: {}, keep: [] });

  const currentType = () => (typeSelect.value === OTHER ? otherType.value.trim() : typeSelect.value);
  const sameType = () => currentType() === detail?.type;

  const renderKnown = (schema: CredentialTypeSchema) => {
    // Hidden fields (fixed URLs, scopes) have no input; their defaults apply when loading
    const formFields = schema.fields.filter((f) => f.kind !== 'hidden');
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    const boxes = new Map<string, HTMLElement>();
    let refresh = () => {
      for (const f of formFields) boxes.get(f.name)!.hidden = !visible(schema, f, values);
    };
    fieldsBox.replaceChildren();
    for (const f of formFields) {
      const stored = sameType() && secretsSet.has(f.name);
      const initial = values[f.name] ?? f.default;
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const set = (v: unknown) => {
        values[f.name] = v;
        refresh();
      };
      if (f.kind === 'options') {
        input = h(
          'select',
          { class: 'param-input', onchange: () => set(input.value) },
          (f.options ?? []).map((x) => h('option', { value: x.value, selected: x.value === initial }, tl(x.label))),
        );
      } else if (f.kind === 'boolean') {
        input = h('input', { type: 'checkbox', checked: initial === true, onchange: () => set((input as HTMLInputElement).checked) });
      } else if (f.kind === 'json' || f.kind === 'text') {
        input = h('textarea', {
          class: `param-input${f.kind === 'json' ? ' json-editor' : ''}`,
          rows: 5,
          spellcheck: false,
          placeholder: stored ? KEPT() : (tl(f.placeholder) ?? ''),
          oninput: () => (values[f.name] = input.value),
        });
        if (!isSecret(f)) input.value = typeof initial === 'string' ? initial : initial === undefined ? '' : JSON.stringify(initial, null, 2);
      } else {
        input = h('input', {
          type: isSecret(f) ? 'password' : 'text',
          class: 'param-input',
          autocomplete: isSecret(f) ? 'new-password' : 'off',
          placeholder: stored ? KEPT() : (tl(f.placeholder) ?? ''),
          oninput: () => (values[f.name] = input.value),
        });
        if (!isSecret(f)) input.value = initial === undefined ? '' : String(initial);
      }
      input.setAttribute('aria-label', tl(f.label));
      inputs.set(f.name, input);
      const box =
        f.kind === 'boolean'
          ? h('div', { class: 'field' }, h('label', { class: 'check' }, input, ` ${tl(f.label)}`), f.hint ? h('span', { class: 'muted small' }, tl(f.hint)) : null)
          : fieldBox(tl(f.label), input, tl(f.hint), f.required);
      boxes.set(f.name, box);
      fieldsBox.append(box);
    }
    // OAuth2 with authorization code / PKCE: redirect URL to enter at the provider
    if ((schema.oauth === 2 || schema.name === 'oAuth2Api') && catalog.oauthCallbackUrl) {
      const box = h(
        'div',
        { class: 'field' },
        h('span', null, t('Redirect URL')),
        h('code', { class: 'mono', style: { wordBreak: 'break-all' } }, catalog.oauthCallbackUrl),
        h('span', { class: 'muted small' }, t('Enter this as the redirect URL at the provider. After saving, connect the credential in the list with "Connect".')),
      );
      boxes.set('__redirect', box);
      fieldsBox.append(box);
    }
    // OAuth1: callback that filuflow sends as oauth_callback; some providers require it in advance
    if ((schema.oauth === 1 || schema.name === 'oAuth1Api') && catalog.oauth1CallbackUrl) {
      const box = h(
        'div',
        { class: 'field' },
        h('span', null, t('Callback URL')),
        h('code', { class: 'mono', style: { wordBreak: 'break-all' } }, catalog.oauth1CallbackUrl),
        h('span', { class: 'muted small' }, t('If the provider requires it, enter this there as the callback URL. After saving, connect the credential in the list with "Connect".')),
      );
      boxes.set('__redirect', box);
      fieldsBox.append(box);
    }
    const baseRefresh = refresh;
    refresh = () => {
      baseRefresh();
      const box = boxes.get('__redirect');
      const grant = values.grantType ?? schema.fields.find((f) => f.name === 'grantType')?.default ?? 'authorizationCode';
      if (box) box.hidden = grant === 'clientCredentials';
    };
    refresh();
    collect = () => {
      const data: Record<string, unknown> = {};
      const keep: string[] = [];
      for (const f of formFields) {
        if (!visible(schema, f, values)) continue;
        const input = inputs.get(f.name)!;
        if (f.kind === 'boolean') {
          data[f.name] = (input as HTMLInputElement).checked;
          continue;
        }
        const v = input.value;
        if (isSecret(f) && v === '') {
          if (sameType() && secretsSet.has(f.name)) keep.push(f.name);
          else if (f.required) return t('{field} is missing', { field: tl(f.label) });
          continue;
        }
        if (f.kind === 'json' && v.trim() && !/\{\{\s*env\./.test(v)) {
          try {
            JSON.parse(v);
          } catch (err) {
            return t('{field}: invalid JSON ({message})', { field: tl(f.label), message: (err as Error).message });
          }
        }
        if (f.required && !v.trim()) return t('{field} is missing', { field: tl(f.label) });
        data[f.name] = v;
      }
      return { data, keep };
    };
  };

  const renderOther = () => {
    const rows = h('div', { class: 'kv-rows' });
    const addRow = (k = '', v = '', stored = false) => {
      const key = h('input', { type: 'text', class: 'param-input', value: k, placeholder: t('Field, e.g. apiKey'), 'aria-label': t('Field') });
      const value = h('input', { type: 'password', class: 'param-input', value: v, placeholder: stored ? KEPT() : t('Value'), autocomplete: 'new-password', 'aria-label': t('Value') });
      const show = iconButton('eye', t('Show value'), () => (value.type = value.type === 'password' ? 'text' : 'password'));
      const row = h('div', { class: 'kv-row kv-row-3' }, key, value, show, iconButton('x', t('Remove field'), () => row.remove()));
      row.dataset.stored = stored ? '1' : '';
      rows.append(row);
    };
    if (sameType()) {
      for (const [k, v] of Object.entries(detail?.data ?? {})) addRow(k, typeof v === 'string' ? v : JSON.stringify(v));
      for (const k of secretsSet) addRow(k, '', true);
    }
    if (!rows.childElementCount) addRow();
    fieldsBox.replaceChildren(
      h('div', { class: 'field' }, h('span', null, t('Fields')), rows, h('button', { type: 'button', class: 'btn btn-small', onclick: () => addRow() }, t('Add field'))),
      h('p', { class: 'muted small' }, t('Field names as in the reference credential type, e.g. apiKey or accessToken. Values are always strings.')),
    );
    collect = () => {
      const data: Record<string, unknown> = {};
      const keep: string[] = [];
      for (const row of rows.querySelectorAll<HTMLElement>('.kv-row')) {
        const [k, v] = row.querySelectorAll('input');
        const key = k.value.trim();
        if (!key) continue;
        if (v.value === '' && row.dataset.stored === '1' && sameType()) keep.push(key);
        else data[key] = v.value;
      }
      if (!Object.keys(data).length && !keep.length) return t('At least one field is required');
      return { data, keep };
    };
  };

  const render = () => {
    const schema = typeSelect.value === OTHER ? undefined : known(typeSelect.value);
    otherBox.hidden = !!schema;
    description.textContent = tl(schema?.description) ?? t('Custom type or type not described here: enter fields freely.');
    if (schema) renderKnown(schema);
    else renderOther();
  };
  typeSelect.addEventListener('change', render);
  otherType.addEventListener('change', () => {
    if (typeSelect.value === OTHER) render();
  });
  render();

  return dialog<CredentialInfo>(
    detail ? t('Edit credential "{name}"', { name: detail.name }) : t('New credential'),
    h(
      'form',
      { class: 'form', onsubmit: (e: Event) => e.preventDefault(), autocomplete: 'off' },
      fieldBox(t('Name'), nameInput, t('Workflows select the credential by this name.'), true),
      fieldBox(t('Type'), typeSelect),
      description,
      otherBox,
      fieldsBox,
      o.extra?.element ?? null,
      h(
        'p',
        { class: 'muted small' },
        o.note ?? t('Secret values are stored on the server and never shown again.'),
        ` ${t('References to environment variables like {{ env.API_KEY }} are possible.')}`,
      ),
    ),
    {
      confirm: o.confirm ?? t('Save'),
      wide: true,
      onConfirm: async () => {
        const name = nameInput.value.trim();
        const type = currentType();
        if (!name) return void toast(t('Name is missing'), 'error');
        if (!type) return void toast(t('Type is missing'), 'error');
        const result = collect();
        if (typeof result === 'string') return void toast(result, 'error');
        const extra = o.extra?.collect() ?? {};
        if (typeof extra === 'string') return void toast(extra, 'error');
        try {
          return await backend.save(detail?.name ?? name, {
            ...extra,
            type,
            data: result.data,
            keep: result.keep,
            ...(detail ? (name !== detail.name ? { rename: name } : {}) : { create: true }),
          });
        } catch (err) {
          toast((err as Error).message, 'error');
          return undefined;
        }
      },
    },
  );
}

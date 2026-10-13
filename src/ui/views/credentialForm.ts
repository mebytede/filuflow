// Formular für ein Credential (Einzelbetrieb und Master). Felder nach der Beschreibung des Typs; für eigene Typen
// freie Felder. Geheime Werte kommen nie vom Server zurück: ein leeres Feld behält den gespeicherten Wert.
import { dialog, h, toast } from '../dom.js';
import { iconButton } from '../shell.js';
import type { CredentialDetail, CredentialField, CredentialInfo, CredentialSaveBody, CredentialTypeCatalog, CredentialTypeSchema } from '../types.js';

export interface CredentialFormBackend {
  types(): Promise<CredentialTypeCatalog>;
  get(name: string): Promise<CredentialDetail>;
  save(name: string, body: CredentialSaveBody): Promise<CredentialInfo>;
}

export interface CredentialFormOptions {
  /** vorhandenes Credential bearbeiten */
  name?: string;
  /** Typ vorgeben (z. B. aus dem Editor); nicht änderbar */
  type?: string;
  /** Hinweis, wo gespeichert wird */
  note?: string;
  confirm?: string;
}

const OTHER = '__other__';
const KEPT = 'gespeichert, leer lassen = unverändert';

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

/** Öffnet das Formular; liefert das gespeicherte Credential oder null bei Abbruch */
export async function credentialFormDialog(backend: CredentialFormBackend, o: CredentialFormOptions = {}): Promise<CredentialInfo | null> {
  const [catalog, detail] = await Promise.all([backend.types(), o.name ? backend.get(o.name) : Promise.resolve(undefined)]);
  const types = catalog.data;
  const secretsSet = new Set(detail?.secretsSet ?? []);
  const originalType = detail?.type ?? o.type;

  const nameInput = h('input', { type: 'text', class: 'param-input', value: detail?.name ?? '', placeholder: 'z. B. Kunden-API', autocomplete: 'off', 'aria-label': 'Name' });
  const known = (t: string | undefined) => types.find((x) => x.name === t);
  const typeSelect = h(
    'select',
    { class: 'param-input', 'aria-label': 'Typ', disabled: !!o.type },
    types.map((t) => h('option', { value: t.name }, `${t.label} (${t.name})`)),
    h('option', { value: OTHER }, 'Anderer Typ'),
  );
  const otherType = h('input', { type: 'text', class: 'param-input', placeholder: 'Typname, z. B. slackApi', 'aria-label': 'Anderer Typ' });
  if (originalType && known(originalType)) typeSelect.value = originalType;
  else if (originalType) {
    typeSelect.value = OTHER;
    otherType.value = originalType;
  } else typeSelect.value = types[0]?.name ?? OTHER;
  otherType.disabled = !!o.type;

  const description = h('p', { class: 'muted small', style: { margin: '-8px 0 16px' } });
  const fieldsBox = h('div');
  const otherBox = fieldBox('Typname', otherType);

  // Aktuelle Werte je Typ (beim Wechsel zurück bleiben Eingaben erhalten)
  const values: Record<string, unknown> = { ...(detail?.data ?? {}) };
  let collect: () => { data: Record<string, unknown>; keep: string[] } | string = () => ({ data: {}, keep: [] });

  const currentType = () => (typeSelect.value === OTHER ? otherType.value.trim() : typeSelect.value);
  const sameType = () => currentType() === detail?.type;

  const renderKnown = (schema: CredentialTypeSchema) => {
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    const boxes = new Map<string, HTMLElement>();
    let refresh = () => {
      for (const f of schema.fields) boxes.get(f.name)!.hidden = !visible(schema, f, values);
    };
    fieldsBox.replaceChildren();
    for (const f of schema.fields) {
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
          (f.options ?? []).map((x) => h('option', { value: x.value, selected: x.value === initial }, x.label)),
        );
      } else if (f.kind === 'boolean') {
        input = h('input', { type: 'checkbox', checked: initial === true, onchange: () => set((input as HTMLInputElement).checked) });
      } else if (f.kind === 'json' || f.kind === 'text') {
        input = h('textarea', {
          class: `param-input${f.kind === 'json' ? ' json-editor' : ''}`,
          rows: 5,
          spellcheck: false,
          placeholder: stored ? KEPT : (f.placeholder ?? ''),
          oninput: () => (values[f.name] = input.value),
        });
        if (!isSecret(f)) input.value = typeof initial === 'string' ? initial : initial === undefined ? '' : JSON.stringify(initial, null, 2);
      } else {
        input = h('input', {
          type: isSecret(f) ? 'password' : 'text',
          class: 'param-input',
          autocomplete: isSecret(f) ? 'new-password' : 'off',
          placeholder: stored ? KEPT : (f.placeholder ?? ''),
          oninput: () => (values[f.name] = input.value),
        });
        if (!isSecret(f)) input.value = initial === undefined ? '' : String(initial);
      }
      input.setAttribute('aria-label', f.label);
      inputs.set(f.name, input);
      const box =
        f.kind === 'boolean'
          ? h('div', { class: 'field' }, h('label', { class: 'check' }, input, ` ${f.label}`), f.hint ? h('span', { class: 'muted small' }, f.hint) : null)
          : fieldBox(f.label, input, f.hint, f.required);
      boxes.set(f.name, box);
      fieldsBox.append(box);
    }
    // OAuth2 mit Authorization Code / PKCE: Redirect-URL zum Eintragen beim Anbieter
    if (schema.name === 'oAuth2Api' && catalog.oauthCallbackUrl) {
      const box = h(
        'div',
        { class: 'field' },
        h('span', null, 'Redirect-URL'),
        h('code', { class: 'mono', style: { wordBreak: 'break-all' } }, catalog.oauthCallbackUrl),
        h('span', { class: 'muted small' }, 'Beim Anbieter als Redirect-URL eintragen. Nach dem Speichern verbinden Sie das Credential in der Liste mit "Verbinden".'),
      );
      boxes.set('__redirect', box);
      fieldsBox.append(box);
    }
    // OAuth1: Rückleitung, die filuflow als oauth_callback mitschickt; manche Anbieter verlangen sie vorab
    if (schema.name === 'oAuth1Api' && catalog.oauth1CallbackUrl) {
      const box = h(
        'div',
        { class: 'field' },
        h('span', null, 'Callback-URL'),
        h('code', { class: 'mono', style: { wordBreak: 'break-all' } }, catalog.oauth1CallbackUrl),
        h('span', { class: 'muted small' }, 'Falls der Anbieter es verlangt, dort als Callback-URL eintragen. Nach dem Speichern verbinden Sie das Credential in der Liste mit "Verbinden".'),
      );
      boxes.set('__redirect', box);
      fieldsBox.append(box);
    }
    const baseRefresh = refresh;
    refresh = () => {
      baseRefresh();
      const box = boxes.get('__redirect');
      const grant = values.grantType ?? 'authorizationCode';
      if (box) box.hidden = grant === 'clientCredentials';
    };
    refresh();
    collect = () => {
      const data: Record<string, unknown> = {};
      const keep: string[] = [];
      for (const f of schema.fields) {
        if (!visible(schema, f, values)) continue;
        const input = inputs.get(f.name)!;
        if (f.kind === 'boolean') {
          data[f.name] = (input as HTMLInputElement).checked;
          continue;
        }
        const v = input.value;
        if (isSecret(f) && v === '') {
          if (sameType() && secretsSet.has(f.name)) keep.push(f.name);
          else if (f.required) return `${f.label} fehlt`;
          continue;
        }
        if (f.kind === 'json' && v.trim() && !/\{\{\s*env\./.test(v)) {
          try {
            JSON.parse(v);
          } catch (err) {
            return `${f.label}: JSON ungültig (${(err as Error).message})`;
          }
        }
        if (f.required && !v.trim()) return `${f.label} fehlt`;
        data[f.name] = v;
      }
      return { data, keep };
    };
  };

  const renderOther = () => {
    const rows = h('div', { class: 'kv-rows' });
    const addRow = (k = '', v = '', stored = false) => {
      const key = h('input', { type: 'text', class: 'param-input', value: k, placeholder: 'Feld, z. B. apiKey', 'aria-label': 'Feld' });
      const value = h('input', { type: 'password', class: 'param-input', value: v, placeholder: stored ? KEPT : 'Wert', autocomplete: 'new-password', 'aria-label': 'Wert' });
      const show = iconButton('eye', 'Wert zeigen', () => (value.type = value.type === 'password' ? 'text' : 'password'));
      const row = h('div', { class: 'kv-row kv-row-3' }, key, value, show, iconButton('x', 'Feld entfernen', () => row.remove()));
      row.dataset.stored = stored ? '1' : '';
      rows.append(row);
    };
    if (sameType()) {
      for (const [k, v] of Object.entries(detail?.data ?? {})) addRow(k, typeof v === 'string' ? v : JSON.stringify(v));
      for (const k of secretsSet) addRow(k, '', true);
    }
    if (!rows.childElementCount) addRow();
    fieldsBox.replaceChildren(
      h('div', { class: 'field' }, h('span', null, 'Felder'), rows, h('button', { type: 'button', class: 'btn btn-small', onclick: () => addRow() }, 'Feld hinzufügen')),
      h('p', { class: 'muted small' }, 'Feldnamen wie im Credential-Typ von n8n, z. B. apiKey oder accessToken. Werte sind immer Zeichenketten.'),
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
      if (!Object.keys(data).length && !keep.length) return 'Mindestens ein Feld ist nötig';
      return { data, keep };
    };
  };

  const render = () => {
    const schema = typeSelect.value === OTHER ? undefined : known(typeSelect.value);
    otherBox.hidden = !!schema;
    description.textContent = schema?.description ?? 'Eigener oder hier nicht beschriebener Typ: Felder frei angeben.';
    if (schema) renderKnown(schema);
    else renderOther();
  };
  typeSelect.addEventListener('change', render);
  otherType.addEventListener('change', () => {
    if (typeSelect.value === OTHER) render();
  });
  render();

  return dialog<CredentialInfo>(
    detail ? `Credential "${detail.name}" bearbeiten` : 'Neues Credential',
    h(
      'form',
      { class: 'form', onsubmit: (e: Event) => e.preventDefault(), autocomplete: 'off' },
      fieldBox('Name', nameInput, 'So wählen Workflows das Credential aus.', true),
      fieldBox('Typ', typeSelect),
      description,
      otherBox,
      fieldsBox,
      h(
        'p',
        { class: 'muted small' },
        o.note ?? 'Geheime Werte werden auf dem Server gespeichert und nie wieder angezeigt.',
        ' Verweise auf Umgebungsvariablen wie {{ env.API_KEY }} sind möglich.',
      ),
    ),
    {
      confirm: o.confirm ?? 'Speichern',
      wide: true,
      onConfirm: async () => {
        const name = nameInput.value.trim();
        const type = currentType();
        if (!name) return void toast('Name fehlt', 'error');
        if (!type) return void toast('Typ fehlt', 'error');
        const result = collect();
        if (typeof result === 'string') return void toast(result, 'error');
        try {
          return await backend.save(detail?.name ?? name, {
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

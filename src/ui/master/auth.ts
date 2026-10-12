// Master: Anmeldung (Passwort, TOTP, SSO), Einrichtung des ersten Admins, eigenes Profil.
import { ApiError } from '../api.js';
import { appendAll, confirmDialog, dialog, formatDate, h, toast } from '../dom.js';
import { mapi } from './api.js';
import { brand } from '../brand.js';
import { pageHead } from '../shell.js';
import { themeChooser } from '../views/settings.js';
import type { AuthStatus, User } from './types.js';

function card(...children: Array<Node | string | null | false>): HTMLElement {
  return h(
    'main',
    { class: 'login' },
    h('div', { class: 'login-card' }, brand(32), ...children),
  );
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), input);
}

function input(type: string, attrs: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', { type, class: 'param-input', ...attrs });
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : `Fehler: ${(err as Error).message}`;
}

/** Anmeldung; ruft onDone nach vollständiger Anmeldung (ggf. mit TOTP) */
export function loginPage(status: AuthStatus, onDone: () => void, notice?: string): HTMLElement {
  const email = input('email', { autocomplete: 'username', placeholder: 'name@firma.de', required: true });
  const password = input('password', { autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error-text', role: 'alert' }, notice ?? '');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Anmelden');
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        submit.disabled = true;
        error.textContent = '';
        try {
          const r = await mapi.login(email.value.trim(), password.value);
          if (r.mfaRequired) root.replaceWith(totpStep(onDone));
          else onDone();
        } catch (err) {
          error.textContent = message(err);
          password.select();
        } finally {
          submit.disabled = false;
        }
      },
    },
    field('E-Mail', email),
    field('Passwort', password),
    error,
    submit,
  );
  const root = card(
    status.mfaPending ? null : form,
    status.oidc.enabled ? h('div', { class: 'login-sep muted small' }, 'oder') : null,
    status.oidc.enabled ? h('a', { class: 'btn', href: '/api/auth/oidc/start' }, status.oidc.label ?? 'Mit SSO anmelden') : null,
  );
  if (status.mfaPending) return totpStep(onDone);
  queueMicrotask(() => email.focus());
  return root;
}

function totpStep(onDone: () => void): HTMLElement {
  const code = input('text', { inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]*', maxlength: 7, placeholder: '123456', 'aria-label': 'Code' });
  const error = h('p', { class: 'error-text', role: 'alert' });
  const root = card(
    h(
      'form',
      {
        class: 'form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          error.textContent = '';
          try {
            await mapi.totp(code.value.replace(/\s/g, ''));
            onDone();
          } catch (err) {
            error.textContent = err instanceof ApiError && err.status === 401 && /Keine Anmeldung/.test(err.message) ? 'Anmeldung abgelaufen, bitte neu anmelden.' : message(err);
            code.select();
          }
        },
      },
      h('p', { class: 'muted' }, 'Code aus der Authenticator-App eingeben.'),
      field('Code', code),
      error,
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Bestätigen'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost',
          onclick: async () => {
            await mapi.logout().catch(() => undefined);
            location.hash = '#/login';
            location.reload();
          },
        },
        'Abbrechen',
      ),
    ),
  );
  queueMicrotask(() => code.focus());
  return root;
}

/** Erster Admin mit dem Einrichtungs-Token aus dem Server-Log */
export function setupPage(onDone: () => void): HTMLElement {
  const token = input('password', { autocomplete: 'off', placeholder: 'aus dem Server-Log', required: true });
  const name = input('text', { autocomplete: 'name', required: true });
  const email = input('email', { autocomplete: 'username', required: true });
  const password = input('password', { autocomplete: 'new-password', minlength: 12, required: true });
  const repeat = input('password', { autocomplete: 'new-password', required: true });
  const error = h('p', { class: 'error-text', role: 'alert' });
  const root = card(
    h('h2', null, 'Einrichtung'),
    h('p', { class: 'muted' }, 'Ersten Administrator anlegen. Das Einrichtungs-Token steht beim Start im Log des Masters ("Einrichtungs-Token").'),
    h(
      'form',
      {
        class: 'form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          error.textContent = '';
          if (password.value !== repeat.value) {
            error.textContent = 'Passwörter stimmen nicht überein';
            return;
          }
          try {
            await mapi.setup({ setupToken: token.value.trim(), name: name.value.trim(), email: email.value.trim(), password: password.value });
            toast('Administrator angelegt', 'success');
            onDone();
          } catch (err) {
            error.textContent = message(err);
          }
        },
      },
      field('Einrichtungs-Token', token),
      field('Name', name),
      field('E-Mail', email),
      field('Passwort (mindestens 12 Zeichen)', password),
      field('Passwort wiederholen', repeat),
      error,
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Administrator anlegen'),
    ),
  );
  queueMicrotask(() => token.focus());
  return root;
}

function groups(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** Eigenes Profil: Name, Passwort, Zwei-Faktor-Anmeldung, API-Tokens */
export async function profilePage(status: AuthStatus, onChanged: (user: User) => void): Promise<HTMLElement> {
  let user = await mapi.me();
  const root = h('section', { class: 'page page-narrow' });
  const render = async () => {
    const tokens = await mapi.tokens();
    root.replaceChildren();
    appendAll(
      root,
      pageHead('Profil', user.name || user.email),
      status.requireTotp && user.hasPassword && !user.totpEnabled
        ? h('div', { class: 'notice notice-warning', role: 'alert' }, 'Zwei-Faktor-Anmeldung ist Pflicht. Bitte jetzt einrichten, danach steht die Oberfläche wieder zur Verfügung.')
        : null,
      nameCard(),
      user.hasPassword || !status.oidc.enabled ? passwordCard() : null,
      user.hasPassword ? totpCard() : null,
      tokenCard(tokens),
      h('div', { class: 'card card-pad' }, h('h2', null, 'Darstellung'), h('div', { class: 'field' }, h('span', null, 'Farbschema'), h('div', null, themeChooser()), h('span', { class: 'muted small' }, 'Gilt für diesen Browser.'))),
    );
  };

  const nameCard = () => {
    const name = input('text', { value: user.name, autocomplete: 'name' });
    return h(
      'div',
      { class: 'card card-pad' },
      h('h2', null, 'Name'),
      h(
        'form',
        {
          class: 'inline-form',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            try {
              user = await mapi.updateMe(name.value);
              onChanged(user);
              toast('Gespeichert', 'success');
            } catch (err) {
              toast(message(err), 'error');
            }
          },
        },
        name,
        h('button', { type: 'submit', class: 'btn' }, 'Speichern'),
      ),
    );
  };

  const passwordCard = () => {
    const current = input('password', { autocomplete: 'current-password' });
    const next = input('password', { autocomplete: 'new-password', minlength: 12 });
    const repeat = input('password', { autocomplete: 'new-password' });
    return h(
      'div',
      { class: 'card card-pad' },
      h('h2', null, user.hasPassword ? 'Passwort ändern' : 'Passwort setzen'),
      h(
        'form',
        {
          class: 'form',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            if (next.value !== repeat.value) return toast('Passwörter stimmen nicht überein', 'error');
            try {
              await mapi.changePassword(current.value, next.value);
              toast('Passwort geändert, andere Sitzungen wurden abgemeldet', 'success');
              user = await mapi.me();
              await render();
            } catch (err) {
              toast(message(err), 'error');
            }
          },
        },
        user.hasPassword ? field('Aktuelles Passwort', current) : null,
        field('Neues Passwort (mindestens 12 Zeichen)', next),
        field('Wiederholen', repeat),
        h('div', null, h('button', { type: 'submit', class: 'btn' }, 'Passwort ändern')),
      ),
    );
  };

  const totpCard = () => {
    const box = h('div', { class: 'card card-pad' }, h('h2', null, 'Zwei-Faktor-Anmeldung (TOTP)'));
    if (user.totpEnabled) {
      box.append(
        h('p', null, h('span', { class: 'pill pill-success' }, 'aktiv'), ' Bei der Anmeldung mit Passwort wird zusätzlich ein Code abgefragt.'),
        status.requireTotp
          ? h('p', { class: 'muted small' }, 'Ist für alle Benutzer mit Passwort vorgeschrieben.')
          : h(
              'button',
              {
                type: 'button',
                class: 'btn btn-danger',
                onclick: async () => {
                  const pw = input('password', { autocomplete: 'current-password' });
                  const ok = await dialog<string>('Zwei-Faktor-Anmeldung abschalten', h('div', { class: 'form' }, field('Passwort zur Bestätigung', pw)), {
                    confirm: 'Abschalten',
                    onConfirm: () => pw.value || undefined,
                  });
                  if (!ok) return;
                  try {
                    user = await mapi.totpDisable(ok);
                    onChanged(user);
                    await render();
                  } catch (err) {
                    toast(message(err), 'error');
                  }
                },
              },
              'Abschalten',
            ),
      );
      return box;
    }
    const start = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            const { secret, uri } = await mapi.totpSetup();
            const code = input('text', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123456', 'aria-label': 'Code' });
            start.replaceWith(
              h(
                'form',
                {
                  class: 'form',
                  onsubmit: async (e: Event) => {
                    e.preventDefault();
                    try {
                      user = await mapi.totpEnable(code.value.replace(/\s/g, ''));
                      onChanged(user);
                      toast('Zwei-Faktor-Anmeldung ist aktiv', 'success');
                      await render();
                    } catch (err) {
                      toast(message(err), 'error');
                      code.select();
                    }
                  },
                },
                h('p', null, 'Schlüssel in der Authenticator-App eintragen (z. B. Aegis, Google Authenticator, 1Password) und den angezeigten Code bestätigen.'),
                field('Schlüssel', h('code', { class: 'secret' }, groups(secret))),
                h('p', { class: 'small' }, h('a', { href: uri }, 'In Authenticator-App öffnen'), h('span', { class: 'muted' }, ' (auf dem Smartphone)')),
                field('Code aus der App', code),
                h('div', null, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Aktivieren')),
              ),
            );
            code.focus();
          } catch (err) {
            toast(message(err), 'error');
          }
        },
      },
      'Einrichten',
    );
    box.append(h('p', { class: 'muted' }, 'Schützt die Anmeldung mit Passwort zusätzlich mit einem Code aus einer Authenticator-App.'), start);
    return box;
  };

  const tokenCard = (tokens: Awaited<ReturnType<typeof mapi.tokens>>) => {
    const name = input('text', { placeholder: 'z. B. CI-Pipeline', 'aria-label': 'Name des Tokens' });
    const days = h(
      'select',
      { class: 'param-input', 'aria-label': 'Gültigkeit' },
      h('option', { value: '30' }, '30 Tage'),
      h('option', { value: '90' }, '90 Tage'),
      h('option', { value: '365' }, '1 Jahr'),
      h('option', { value: '0' }, 'unbegrenzt'),
    );
    return h(
      'div',
      { class: 'card card-pad' },
      h('h2', null, 'API-Tokens'),
      h('p', { class: 'muted small' }, 'Für Skripte und Automatisierung: Header "Authorization: Bearer ffl_…". Ein Token hat dieselben Rechte wie Ihr Konto.'),
      tokens.length
        ? h(
            'table',
            { class: 'list-table' },
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Angelegt'), h('th', null, 'Zuletzt benutzt'), h('th', null, 'Läuft ab'), h('th', null, ''))),
            h(
              'tbody',
              null,
              tokens.map((t) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'strong' }, t.name),
                  h('td', null, formatDate(t.createdAt)),
                  h('td', null, t.lastUsedAt ? formatDate(t.lastUsedAt) : 'nie'),
                  h('td', null, t.expiresAt ? formatDate(t.expiresAt) : 'nie'),
                  h(
                    'td',
                    { class: 'actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-small btn-danger',
                        onclick: async () => {
                          if (!(await confirmDialog('Token widerrufen', `"${t.name}" kann danach nicht mehr verwendet werden.`, 'Widerrufen'))) return;
                          await mapi.deleteToken(t.id);
                          await render();
                        },
                      },
                      'Widerrufen',
                    ),
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        'form',
        {
          class: 'inline-form',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            if (!name.value.trim()) return;
            try {
              const created = await mapi.createToken(name.value.trim(), Number(days.value));
              await dialog(
                'Neuer API-Token',
                h('div', { class: 'form' }, h('p', null, 'Der Token wird nur jetzt angezeigt. Bitte sicher ablegen.'), h('code', { class: 'secret' }, created.token)),
                { confirm: 'Fertig', cancel: '' },
              );
              await render();
            } catch (err) {
              toast(message(err), 'error');
            }
          },
        },
        name,
        days,
        h('button', { type: 'submit', class: 'btn' }, 'Token anlegen'),
      ),
    );
  };

  await render();
  return root;
}

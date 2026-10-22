// Master: sign-in (password, TOTP, SSO), setup of the first admin, own profile.
import { ApiError } from '../api.js';
import { appendAll, confirmDialog, dialog, formatDate, h, toast } from '../dom.js';
import { mapi } from './api.js';
import { brand } from '../brand.js';
import { pageHead } from '../shell.js';
import { themeChooser } from '../views/settings.js';
import type { AuthStatus, User } from './types.js';
import { getLocale, setLocale, t, type Locale } from '../i18n.js';

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
  return err instanceof ApiError ? err.message : t('Error: {message}', { message: (err as Error).message });
}

/** Language selection (English is the default); applies to this browser and reloads the page */
function localeChooser(): HTMLElement {
  const current = getLocale();
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('Language') },
    ...([['en', 'English'], ['de', 'Deutsch']] as Array<[Locale, string]>).map(([value, text]) =>
      h('button', { type: 'button', class: current === value ? 'on' : '', 'aria-pressed': String(current === value), lang: value, onclick: () => current !== value && setLocale(value) }, text),
    ),
  );
}

/** Sign-in; calls onDone after complete sign-in (with TOTP if required) */
export function loginPage(status: AuthStatus, onDone: () => void, notice?: string): HTMLElement {
  const email = input('email', { autocomplete: 'username', placeholder: t('name@company.com'), required: true });
  const password = input('password', { autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error-text', role: 'alert' }, notice ?? '');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, t('Sign in'));
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
    field(t('Email'), email),
    field(t('Password'), password),
    error,
    submit,
  );
  const root = card(
    status.mfaPending ? null : form,
    status.oidc.enabled ? h('div', { class: 'login-sep muted small' }, t('or')) : null,
    status.oidc.enabled ? h('a', { class: 'btn', href: '/api/auth/oidc/start' }, status.oidc.label ?? t('Sign in with SSO')) : null,
  );
  root.querySelector('.login-card')?.append(h('div', { class: 'login-locale', style: { marginTop: '16px', display: 'flex', justifyContent: 'center' } }, localeChooser()));
  if (status.mfaPending) return totpStep(onDone);
  queueMicrotask(() => email.focus());
  return root;
}

function totpStep(onDone: () => void): HTMLElement {
  const code = input('text', { inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]*', maxlength: 7, placeholder: '123456', 'aria-label': t('Code') });
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
            error.textContent = err instanceof ApiError && err.status === 401 && /Keine Anmeldung|pending/i.test(err.message) ? t('Sign-in expired, please sign in again.') : message(err);
            code.select();
          }
        },
      },
      h('p', { class: 'muted' }, t('Enter the code from the authenticator app.')),
      field(t('Code'), code),
      error,
      h('button', { type: 'submit', class: 'btn btn-primary' }, t('Confirm')),
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
        t('Cancel'),
      ),
    ),
  );
  queueMicrotask(() => code.focus());
  return root;
}

/** First admin with the setup token from the server log */
export function setupPage(onDone: () => void): HTMLElement {
  const token = input('password', { autocomplete: 'off', placeholder: t('from the server log'), required: true });
  const name = input('text', { autocomplete: 'name', required: true });
  const email = input('email', { autocomplete: 'username', required: true });
  const password = input('password', { autocomplete: 'new-password', minlength: 12, required: true });
  const repeat = input('password', { autocomplete: 'new-password', required: true });
  const error = h('p', { class: 'error-text', role: 'alert' });
  const root = card(
    h('h2', null, t('Setup')),
    h('p', { class: 'muted' }, t('Create the first administrator. The setup token is printed in the master log at startup ("setup token").')),
    h(
      'form',
      {
        class: 'form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          error.textContent = '';
          if (password.value !== repeat.value) {
            error.textContent = t('Passwords do not match');
            return;
          }
          try {
            await mapi.setup({ setupToken: token.value.trim(), name: name.value.trim(), email: email.value.trim(), password: password.value });
            toast(t('Administrator created'), 'success');
            onDone();
          } catch (err) {
            error.textContent = message(err);
          }
        },
      },
      field(t('Setup token'), token),
      field(t('Name'), name),
      field(t('Email'), email),
      field(t('Password (at least 12 characters)'), password),
      field(t('Repeat password'), repeat),
      error,
      h('button', { type: 'submit', class: 'btn btn-primary' }, t('Create administrator')),
    ),
  );
  queueMicrotask(() => token.focus());
  return root;
}

function groups(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** Own profile: name, password, two-factor sign-in, API tokens */
export async function profilePage(status: AuthStatus, onChanged: (user: User) => void): Promise<HTMLElement> {
  let user = await mapi.me();
  const root = h('section', { class: 'page page-narrow' });
  const render = async () => {
    const tokens = await mapi.tokens();
    root.replaceChildren();
    appendAll(
      root,
      pageHead(t('Profile'), user.name || user.email),
      status.requireTotp && user.hasPassword && !user.totpEnabled
        ? h('div', { class: 'notice notice-warning', role: 'alert' }, t('Two-factor sign-in is mandatory. Please set it up now, then the interface will be available again.'))
        : null,
      nameCard(),
      user.hasPassword || !status.oidc.enabled ? passwordCard() : null,
      user.hasPassword ? totpCard() : null,
      tokenCard(tokens),
      h(
        'div',
        { class: 'card card-pad' },
        h('h2', null, t('Appearance')),
        h('div', { class: 'field' }, h('span', null, t('Color scheme')), h('div', null, themeChooser()), h('span', { class: 'muted small' }, t('Applies to this browser.'))),
        h('div', { class: 'field' }, h('span', null, t('Language')), h('div', null, localeChooser()), h('span', { class: 'muted small' }, t('Applies to this browser.'))),
      ),
    );
  };

  const nameCard = () => {
    const name = input('text', { value: user.name, autocomplete: 'name' });
    return h(
      'div',
      { class: 'card card-pad' },
      h('h2', null, t('Name')),
      h(
        'form',
        {
          class: 'inline-form',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            try {
              user = await mapi.updateMe(name.value);
              onChanged(user);
              toast(t('Saved'), 'success');
            } catch (err) {
              toast(message(err), 'error');
            }
          },
        },
        name,
        h('button', { type: 'submit', class: 'btn' }, t('Save')),
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
      h('h2', null, user.hasPassword ? t('Change password') : t('Set password')),
      h(
        'form',
        {
          class: 'form',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            if (next.value !== repeat.value) return toast(t('Passwords do not match'), 'error');
            try {
              await mapi.changePassword(current.value, next.value);
              toast(t('Password changed, other sessions were signed out'), 'success');
              user = await mapi.me();
              await render();
            } catch (err) {
              toast(message(err), 'error');
            }
          },
        },
        user.hasPassword ? field(t('Current password'), current) : null,
        field(t('New password (at least 12 characters)'), next),
        field(t('Repeat'), repeat),
        h('div', null, h('button', { type: 'submit', class: 'btn' }, t('Change password'))),
      ),
    );
  };

  const totpCard = () => {
    const box = h('div', { class: 'card card-pad' }, h('h2', null, t('Two-factor sign-in (TOTP)')));
    if (user.totpEnabled) {
      box.append(
        h('p', null, h('span', { class: 'pill pill-success' }, t('active')), ` ${t('Signing in with a password also asks for a code.')}`),
        status.requireTotp
          ? h('p', { class: 'muted small' }, t('Required for all users with a password.'))
          : h(
              'button',
              {
                type: 'button',
                class: 'btn btn-danger',
                onclick: async () => {
                  const pw = input('password', { autocomplete: 'current-password' });
                  const ok = await dialog<string>(t('Turn off two-factor sign-in'), h('div', { class: 'form' }, field(t('Password for confirmation'), pw)), {
                    confirm: t('Turn off'),
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
              t('Turn off'),
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
            const code = input('text', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123456', 'aria-label': t('Code') });
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
                      toast(t('Two-factor sign-in is active'), 'success');
                      await render();
                    } catch (err) {
                      toast(message(err), 'error');
                      code.select();
                    }
                  },
                },
                h('p', null, t('Enter the key in the authenticator app (e.g. Aegis, Google Authenticator, 1Password) and confirm the code shown.')),
                field(t('Key'), h('code', { class: 'secret' }, groups(secret))),
                h('p', { class: 'small' }, h('a', { href: uri }, t('Open in authenticator app')), h('span', { class: 'muted' }, ` ${t('(on the smartphone)')}`)),
                field(t('Code from the app'), code),
                h('div', null, h('button', { type: 'submit', class: 'btn btn-primary' }, t('Activate'))),
              ),
            );
            code.focus();
          } catch (err) {
            toast(message(err), 'error');
          }
        },
      },
      t('Set up'),
    );
    box.append(h('p', { class: 'muted' }, t('Additionally protects password sign-in with a code from an authenticator app.')), start);
    return box;
  };

  const tokenCard = (tokens: Awaited<ReturnType<typeof mapi.tokens>>) => {
    const name = input('text', { placeholder: t('e.g. CI pipeline'), 'aria-label': t('Token name') });
    const days = h(
      'select',
      { class: 'param-input', 'aria-label': t('Validity') },
      h('option', { value: '30' }, t('{n} days', { n: 30 })),
      h('option', { value: '90' }, t('{n} days', { n: 90 })),
      h('option', { value: '365' }, t('1 year')),
      h('option', { value: '0' }, t('unlimited')),
    );
    return h(
      'div',
      { class: 'card card-pad' },
      h('h2', null, t('API tokens')),
      h('p', { class: 'muted small' }, t('For scripts and automation: header "Authorization: Bearer ffl_…". A token has the same permissions as your account.')),
      tokens.length
        ? h(
            'table',
            { class: 'list-table' },
            h('thead', null, h('tr', null, h('th', null, t('Name')), h('th', null, t('Created')), h('th', null, t('Last used')), h('th', null, t('Expires')), h('th', null, ''))),
            h(
              'tbody',
              null,
              tokens.map((tok) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'strong' }, tok.name),
                  h('td', null, formatDate(tok.createdAt)),
                  h('td', null, tok.lastUsedAt ? formatDate(tok.lastUsedAt) : t('never')),
                  h('td', null, tok.expiresAt ? formatDate(tok.expiresAt) : t('never')),
                  h(
                    'td',
                    { class: 'actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-small btn-danger',
                        onclick: async () => {
                          if (!(await confirmDialog(t('Revoke token'), t('"{name}" can no longer be used afterwards.', { name: tok.name }), t('Revoke')))) return;
                          await mapi.deleteToken(tok.id);
                          await render();
                        },
                      },
                      t('Revoke'),
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
                t('New API token'),
                h('div', { class: 'form' }, h('p', null, t('The token is shown only now. Please store it safely.')), h('code', { class: 'secret' }, created.token)),
                { confirm: t('Done'), cancel: '' },
              );
              await render();
            } catch (err) {
              toast(message(err), 'error');
            }
          },
        },
        name,
        days,
        h('button', { type: 'submit', class: 'btn' }, t('Create token')),
      ),
    );
  };

  await render();
  return root;
}

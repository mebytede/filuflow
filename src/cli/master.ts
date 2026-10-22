// filuflow master: master server (users, permissions, projects, tenants, workers) and user management
// on the command line (e.g. first admin, emergency access after a lost TOTP).
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createMasterServer } from '../master/app.js';
import { MasterDb } from '../master/db.js';
import { checkPasswordPolicy, hashPassword } from '../master/auth.js';
import type { OidcConfig } from '../master/oidc.js';
import { getLogger } from '../logger.js';

const USAGE = `Usage: filuflow master [options]
       filuflow master user add --email <address> [--name <name>] [--admin]
       filuflow master user list
       filuflow master user set-password --email <address>
       filuflow master user reset-totp --email <address>

  --port <number>    Port (default: FILUFLOW_PORT or 5679)
  --host <address>   Address (default: FILUFLOW_HOST or 0.0.0.0)
  --db <path>        SQLite file of the master (default: FILUFLOW_MASTER_DB or ./master.db)

Environment:
  FILUFLOW_ENCRYPTION_KEY   required: encrypts worker tokens and TOTP secrets
  FILUFLOW_PUBLIC_URL       public address, e.g. https://filuflow.example (cookies with Secure for https)
  FILUFLOW_ADMIN_EMAIL, FILUFLOW_ADMIN_PASSWORD   first admin on first start (otherwise a setup token in the log)
  FILUFLOW_SESSION_HOURS    session expires after this many hours without activity (default 12)
  FILUFLOW_SYNC_SECONDS     sync with the workers (default 60, 0 = off)
  FILUFLOW_TRUST_PROXY=true evaluate X-Forwarded-For (only behind a reverse proxy)
  FILUFLOW_OIDC_ISSUER, FILUFLOW_OIDC_CLIENT_ID, FILUFLOW_OIDC_CLIENT_SECRET   OIDC sign-in
  FILUFLOW_OIDC_LABEL, FILUFLOW_OIDC_SCOPES, FILUFLOW_OIDC_AUTO_CREATE=true, FILUFLOW_OIDC_ADMIN_GROUP,
  FILUFLOW_OIDC_GROUPS_CLAIM, FILUFLOW_OIDC_ALLOWED_DOMAINS (comma-separated)
  Password for "user add/set-password": FILUFLOW_NEW_PASSWORD or prompt
`;

function oidcFromEnv(publicUrl: string): OidcConfig | undefined {
  const env = process.env;
  if (!env.FILUFLOW_OIDC_ISSUER || !env.FILUFLOW_OIDC_CLIENT_ID) return undefined;
  return {
    issuer: env.FILUFLOW_OIDC_ISSUER,
    clientId: env.FILUFLOW_OIDC_CLIENT_ID,
    clientSecret: env.FILUFLOW_OIDC_CLIENT_SECRET || undefined,
    redirectUrl: `${publicUrl}/api/auth/oidc/callback`,
    scopes: env.FILUFLOW_OIDC_SCOPES || undefined,
    label: env.FILUFLOW_OIDC_LABEL || undefined,
    autoCreate: env.FILUFLOW_OIDC_AUTO_CREATE === 'true',
    adminGroup: env.FILUFLOW_OIDC_ADMIN_GROUP || undefined,
    groupsClaim: env.FILUFLOW_OIDC_GROUPS_CLAIM || undefined,
    allowedDomains: (env.FILUFLOW_OIDC_ALLOWED_DOMAINS ?? '').split(',').map((d) => d.trim()).filter(Boolean),
  };
}

async function askPassword(prompt: string): Promise<string> {
  if (process.env.FILUFLOW_NEW_PASSWORD) return process.env.FILUFLOW_NEW_PASSWORD;
  if (!process.stdin.isTTY) {
    // Read from a pipe (first line)
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return '';
  }
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return new Promise((resolveValue) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolveValue(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function userCommand(args: string[], dbFile: string): Promise<number> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({ args: rest, options: { email: { type: 'string' }, name: { type: 'string' }, admin: { type: 'boolean', default: false } } });
  const db = new MasterDb(dbFile);
  try {
    if (sub === 'list') {
      for (const u of db.listUsers()) {
        process.stdout.write(`${u.email.padEnd(32)} ${u.role.padEnd(7)} ${u.totp_enabled ? 'TOTP' : '    '} ${u.disabled ? 'disabled' : ''}\n`);
      }
      return 0;
    }
    if (!values.email) {
      process.stderr.write(`--email is missing\n\n${USAGE}`);
      return 1;
    }
    if (sub === 'add') {
      if (db.getUserByEmail(values.email)) {
        process.stderr.write('User already exists\n');
        return 1;
      }
      const password = await askPassword('Password: ');
      const policy = checkPasswordPolicy(password);
      if (policy) {
        process.stderr.write(`${policy}\n`);
        return 1;
      }
      const user = db.createUser({ email: values.email, name: values.name ?? values.email, passwordHash: await hashPassword(password), role: values.admin ? 'admin' : 'member' });
      db.audit({ userId: null, email: null, action: 'user.created_cli', target: user.id, details: { email: user.email, role: user.role } });
      process.stdout.write(`User ${user.email} created (${user.role})\n`);
      return 0;
    }
    const user = db.getUserByEmail(values.email);
    if (!user) {
      process.stderr.write('User not found\n');
      return 1;
    }
    if (sub === 'set-password') {
      const password = await askPassword('New password: ');
      const policy = checkPasswordPolicy(password);
      if (policy) {
        process.stderr.write(`${policy}\n`);
        return 1;
      }
      db.updateUser(user.id, { password_hash: await hashPassword(password), failed_logins: 0, locked_until: null, disabled: 0 });
      db.deleteUserSessions(user.id);
      db.audit({ userId: null, email: null, action: 'user.password_cli', target: user.id });
      process.stdout.write('Password set, sessions ended\n');
      return 0;
    }
    if (sub === 'reset-totp') {
      db.updateUser(user.id, { totp_enabled: 0, totp_secret: null, totp_last_counter: null });
      db.audit({ userId: null, email: null, action: 'user.totp_reset_cli', target: user.id });
      process.stdout.write('Two-factor authentication reset\n');
      return 0;
    }
    process.stderr.write(`Unknown subcommand "${sub ?? ''}"\n\n${USAGE}`);
    return 1;
  } finally {
    db.close();
  }
}

export async function cmdMaster(args: string[]): Promise<number> {
  const env = process.env;
  if (args[0] === 'user') {
    const dbIndex = args.indexOf('--db');
    const dbFile = resolve(dbIndex >= 0 ? args[dbIndex + 1] : (env.FILUFLOW_MASTER_DB ?? 'master.db'));
    const rest = dbIndex >= 0 ? args.slice(1).filter((_a, i) => i + 1 !== dbIndex && i + 1 !== dbIndex + 1) : args.slice(1);
    return userCommand(rest, dbFile);
  }
  let values;
  try {
    ({ values } = parseArgs({ args, options: { port: { type: 'string' }, host: { type: 'string' }, db: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } } }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const logger = getLogger();
  const port = Number(values.port ?? env.FILUFLOW_PORT ?? 5679);
  const host = values.host ?? env.FILUFLOW_HOST ?? '0.0.0.0';
  const publicUrl = (env.FILUFLOW_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const dbFile = resolve(values.db ?? env.FILUFLOW_MASTER_DB ?? 'master.db');
  let server;
  try {
    server = await createMasterServer({
      dbFile,
      encryptionKey: env.FILUFLOW_ENCRYPTION_KEY ?? '',
      publicUrl,
      logger,
      sessionIdleHours: Number(env.FILUFLOW_SESSION_HOURS ?? 12),
      syncIntervalMs: Number(env.FILUFLOW_SYNC_SECONDS ?? 60) * 1000,
      oidc: oidcFromEnv(publicUrl),
      trustProxy: env.FILUFLOW_TRUST_PROXY === 'true',
      ...(env.FILUFLOW_UI === 'false' ? { uiDir: false as const } : {}),
    });
  } catch (error) {
    process.stderr.write(`filuflow master: ${(error as Error).message}\n`);
    return 1;
  }
  // First admin from the environment
  if (server.db.countUsers() === 0 && env.FILUFLOW_ADMIN_EMAIL && env.FILUFLOW_ADMIN_PASSWORD) {
    const policy = checkPasswordPolicy(env.FILUFLOW_ADMIN_PASSWORD);
    if (policy) {
      process.stderr.write(`FILUFLOW_ADMIN_PASSWORD: ${policy}\n`);
      await server.close();
      return 1;
    }
    server.db.createUser({ email: env.FILUFLOW_ADMIN_EMAIL, name: env.FILUFLOW_ADMIN_EMAIL, passwordHash: await hashPassword(env.FILUFLOW_ADMIN_PASSWORD), role: 'admin' });
    logger.info({ email: env.FILUFLOW_ADMIN_EMAIL }, 'First admin created');
  }
  await server.app.listen({ port, host });
  logger.info({ port, host, publicUrl, oidc: env.FILUFLOW_OIDC_ISSUER ? 'active' : 'off' }, 'filuflow master running');
  if (server.db.countUsers() === 0 && server.setupToken) {
    logger.warn({ url: `${publicUrl}/#/setup`, setupToken: server.setupToken }, 'No user yet: create the first admin with this setup token');
  }
  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', () => resolveStop());
    process.once('SIGTERM', () => resolveStop());
  });
  await server.close();
  return 0;
}

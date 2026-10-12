// flowlite master: Master-Server (Benutzer, Rechte, Projekte, Mandanten, Worker) und Benutzerverwaltung
// auf der Kommandozeile (z. B. erster Admin, Notfall-Zugang bei verlorenem TOTP).
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createMasterServer } from '../master/app.js';
import { MasterDb } from '../master/db.js';
import { checkPasswordPolicy, hashPassword } from '../master/auth.js';
import type { OidcConfig } from '../master/oidc.js';
import { getLogger } from '../logger.js';

const USAGE = `Aufruf: flowlite master [Optionen]
       flowlite master user add --email <adresse> [--name <name>] [--admin]
       flowlite master user list
       flowlite master user set-password --email <adresse>
       flowlite master user reset-totp --email <adresse>

  --port <zahl>      Port (Default: FLOWLITE_PORT oder 5679)
  --host <adresse>   Adresse (Default: FLOWLITE_HOST oder 0.0.0.0)
  --db <pfad>        SQLite-Datei des Masters (Default: FLOWLITE_MASTER_DB oder ./master.db)

Umgebung:
  FLOWLITE_ENCRYPTION_KEY   Pflicht: verschlüsselt Worker-Tokens und TOTP-Schlüssel
  FLOWLITE_PUBLIC_URL       öffentliche Adresse, z. B. https://flowlite.example (Cookies mit Secure bei https)
  FLOWLITE_ADMIN_EMAIL, FLOWLITE_ADMIN_PASSWORD   erster Admin beim ersten Start (sonst Einrichtungs-Token im Log)
  FLOWLITE_SESSION_HOURS    Sitzung läuft nach so vielen Stunden ohne Aktivität ab (Default 12)
  FLOWLITE_SYNC_SECONDS     Abgleich mit den Workern (Default 60, 0 = aus)
  FLOWLITE_TRUST_PROXY=true X-Forwarded-For auswerten (nur hinter einem Reverse Proxy)
  FLOWLITE_OIDC_ISSUER, FLOWLITE_OIDC_CLIENT_ID, FLOWLITE_OIDC_CLIENT_SECRET   OIDC-Anmeldung
  FLOWLITE_OIDC_LABEL, FLOWLITE_OIDC_SCOPES, FLOWLITE_OIDC_AUTO_CREATE=true, FLOWLITE_OIDC_ADMIN_GROUP,
  FLOWLITE_OIDC_GROUPS_CLAIM, FLOWLITE_OIDC_ALLOWED_DOMAINS (kommagetrennt)
  Passwort für "user add/set-password": FLOWLITE_NEW_PASSWORD oder Eingabe
`;

function oidcFromEnv(publicUrl: string): OidcConfig | undefined {
  const env = process.env;
  if (!env.FLOWLITE_OIDC_ISSUER || !env.FLOWLITE_OIDC_CLIENT_ID) return undefined;
  return {
    issuer: env.FLOWLITE_OIDC_ISSUER,
    clientId: env.FLOWLITE_OIDC_CLIENT_ID,
    clientSecret: env.FLOWLITE_OIDC_CLIENT_SECRET || undefined,
    redirectUrl: `${publicUrl}/api/auth/oidc/callback`,
    scopes: env.FLOWLITE_OIDC_SCOPES || undefined,
    label: env.FLOWLITE_OIDC_LABEL || undefined,
    autoCreate: env.FLOWLITE_OIDC_AUTO_CREATE === 'true',
    adminGroup: env.FLOWLITE_OIDC_ADMIN_GROUP || undefined,
    groupsClaim: env.FLOWLITE_OIDC_GROUPS_CLAIM || undefined,
    allowedDomains: (env.FLOWLITE_OIDC_ALLOWED_DOMAINS ?? '').split(',').map((d) => d.trim()).filter(Boolean),
  };
}

async function askPassword(prompt: string): Promise<string> {
  if (process.env.FLOWLITE_NEW_PASSWORD) return process.env.FLOWLITE_NEW_PASSWORD;
  if (!process.stdin.isTTY) {
    // Aus einer Pipe lesen (erste Zeile)
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
        process.stdout.write(`${u.email.padEnd(32)} ${u.role.padEnd(7)} ${u.totp_enabled ? 'TOTP' : '    '} ${u.disabled ? 'gesperrt' : ''}\n`);
      }
      return 0;
    }
    if (!values.email) {
      process.stderr.write(`--email fehlt\n\n${USAGE}`);
      return 1;
    }
    if (sub === 'add') {
      if (db.getUserByEmail(values.email)) {
        process.stderr.write('Benutzer existiert bereits\n');
        return 1;
      }
      const password = await askPassword('Passwort: ');
      const policy = checkPasswordPolicy(password);
      if (policy) {
        process.stderr.write(`${policy}\n`);
        return 1;
      }
      const user = db.createUser({ email: values.email, name: values.name ?? values.email, passwordHash: await hashPassword(password), role: values.admin ? 'admin' : 'member' });
      db.audit({ userId: null, email: null, action: 'user.created_cli', target: user.id, details: { email: user.email, role: user.role } });
      process.stdout.write(`Benutzer ${user.email} angelegt (${user.role})\n`);
      return 0;
    }
    const user = db.getUserByEmail(values.email);
    if (!user) {
      process.stderr.write('Benutzer nicht gefunden\n');
      return 1;
    }
    if (sub === 'set-password') {
      const password = await askPassword('Neues Passwort: ');
      const policy = checkPasswordPolicy(password);
      if (policy) {
        process.stderr.write(`${policy}\n`);
        return 1;
      }
      db.updateUser(user.id, { password_hash: await hashPassword(password), failed_logins: 0, locked_until: null, disabled: 0 });
      db.deleteUserSessions(user.id);
      db.audit({ userId: null, email: null, action: 'user.password_cli', target: user.id });
      process.stdout.write('Passwort gesetzt, Sitzungen beendet\n');
      return 0;
    }
    if (sub === 'reset-totp') {
      db.updateUser(user.id, { totp_enabled: 0, totp_secret: null, totp_last_counter: null });
      db.audit({ userId: null, email: null, action: 'user.totp_reset_cli', target: user.id });
      process.stdout.write('Zwei-Faktor-Anmeldung zurückgesetzt\n');
      return 0;
    }
    process.stderr.write(`Unbekannter Unterbefehl "${sub ?? ''}"\n\n${USAGE}`);
    return 1;
  } finally {
    db.close();
  }
}

export async function cmdMaster(args: string[]): Promise<number> {
  const env = process.env;
  if (args[0] === 'user') {
    const dbIndex = args.indexOf('--db');
    const dbFile = resolve(dbIndex >= 0 ? args[dbIndex + 1] : (env.FLOWLITE_MASTER_DB ?? 'master.db'));
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
  const port = Number(values.port ?? env.FLOWLITE_PORT ?? 5679);
  const host = values.host ?? env.FLOWLITE_HOST ?? '0.0.0.0';
  const publicUrl = (env.FLOWLITE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const dbFile = resolve(values.db ?? env.FLOWLITE_MASTER_DB ?? 'master.db');
  let server;
  try {
    server = await createMasterServer({
      dbFile,
      encryptionKey: env.FLOWLITE_ENCRYPTION_KEY ?? '',
      publicUrl,
      logger,
      sessionIdleHours: Number(env.FLOWLITE_SESSION_HOURS ?? 12),
      syncIntervalMs: Number(env.FLOWLITE_SYNC_SECONDS ?? 60) * 1000,
      oidc: oidcFromEnv(publicUrl),
      trustProxy: env.FLOWLITE_TRUST_PROXY === 'true',
      ...(env.FLOWLITE_UI === 'false' ? { uiDir: false as const } : {}),
    });
  } catch (error) {
    process.stderr.write(`flowlite master: ${(error as Error).message}\n`);
    return 1;
  }
  // Erster Admin aus der Umgebung
  if (server.db.countUsers() === 0 && env.FLOWLITE_ADMIN_EMAIL && env.FLOWLITE_ADMIN_PASSWORD) {
    const policy = checkPasswordPolicy(env.FLOWLITE_ADMIN_PASSWORD);
    if (policy) {
      process.stderr.write(`FLOWLITE_ADMIN_PASSWORD: ${policy}\n`);
      await server.close();
      return 1;
    }
    server.db.createUser({ email: env.FLOWLITE_ADMIN_EMAIL, name: env.FLOWLITE_ADMIN_EMAIL, passwordHash: await hashPassword(env.FLOWLITE_ADMIN_PASSWORD), role: 'admin' });
    logger.info({ email: env.FLOWLITE_ADMIN_EMAIL }, 'Erster Admin angelegt');
  }
  await server.app.listen({ port, host });
  logger.info({ port, host, publicUrl, oidc: env.FLOWLITE_OIDC_ISSUER ? 'aktiv' : 'aus' }, 'flowlite-Master läuft');
  if (server.db.countUsers() === 0 && server.setupToken) {
    logger.warn({ url: `${publicUrl}/#/setup`, setupToken: server.setupToken }, 'Noch kein Benutzer: ersten Admin mit diesem Einrichtungs-Token anlegen');
  }
  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', () => resolveStop());
    process.once('SIGTERM', () => resolveStop());
  });
  await server.close();
  return 0;
}

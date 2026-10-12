// Anmeldung im Master: Passwörter (scrypt), TOTP (RFC 6238), Sitzungs- und API-Tokens, Verschlüsselung
// gespeicherter Geheimnisse (TOTP-Schlüssel, Worker-Tokens) mit FLOWLITE_ENCRYPTION_KEY.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { decryptValue, encryptValue } from '../credentials/store.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

// scrypt mit N=2^15, r=8, p=1 (OWASP-Empfehlung), 64 Byte Schlüssel
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const MIN_PASSWORD_LENGTH = 12;

export function checkPasswordPolicy(password: string): string | undefined {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben`;
  if (password.length > 1024) return 'Passwort ist zu lang';
  return undefined;
}

/** Format: scrypt$N$r$p$salt$hash (base64) */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Gleicher Zeitaufwand bei unbekannten Benutzern (kein Rückschluss auf vorhandene Konten) */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('flowlite-dummy-password');
  await verifyPassword(password, await dummyHash);
}

// -----------------------------------------------------------------------------------------------
// Tokens

export function randomToken(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// -----------------------------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 30 s, 6 Stellen) wie Google Authenticator & Co.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Ungültiger Base32-Schlüssel');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export function totpCounter(time = Date.now()): number {
  return Math.floor(time / 1000 / 30);
}

/**
 * Prüft einen Code (Zeitfenster ±1 Schritt). Liefert den Zähler des Treffers, damit derselbe Code nicht
 * zweimal genutzt werden kann (lastCounter), sonst undefined.
 */
export function verifyTotp(secret: string, code: string, lastCounter: number | null, time = Date.now()): number | undefined {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return undefined;
  const current = totpCounter(time);
  for (const c of [current - 1, current, current + 1]) {
    if (lastCounter !== null && c <= lastCounter) continue;
    if (safeEqual(totpCode(secret, c), clean)) return c;
  }
  return undefined;
}

export function totpUri(secret: string, account: string, issuer = 'flowlite'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// -----------------------------------------------------------------------------------------------
// Geheimnisse in der Datenbank

export class SecretBox {
  constructor(private readonly key: string) {
    if (!key || key.length < 16) throw new Error('FLOWLITE_ENCRYPTION_KEY fehlt oder ist kürzer als 16 Zeichen (Pflicht im Master-Modus)');
  }

  seal(value: string): string {
    return encryptValue(value, this.key);
  }

  open(sealed: string): string {
    return String(decryptValue(sealed, this.key));
  }
}

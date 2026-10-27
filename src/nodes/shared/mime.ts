// MIME messages for the Gmail nodes (M40): composing (RFC 5322, RFC 2045 to 2047, RFC 2231) and parsing. Own
// implementation without a mail library (decision in docs/DECISIONS.md).
//
// Composing reproduces the structure that n8n-nodes-base 1.121.0 nodes/Google/Gmail/GenericFunctions.js encodeEmail
// gets from nodemailer 7.0.10 (lib/mail-composer, lib/mime-node): single part, multipart/alternative or
// multipart/mixed with attachments, header order (Content-Type last on the root), Bcc kept, encoded words for non-ASCII
// header values, transfer encoding 7bit / quoted-printable / base64 depending on the text, boundaries
// "--_NmP-<hex>-Part_<n>", Message-ID with the domain of the sender.
//
// Parsing produces the fields that GenericFunctions.js parseRawEmail takes from mailparser 3.6.7 simpleParser
// (lib/mail-parser.js, lib/simple-parser.js, with mailsplit 5.4.0 and libmime 5.2.1): headerLines, text, html (false
// without an HTML part), textAsHtml, subject, references, date, to, from, cc, bcc, messageId, inReplyTo, replyTo and
// attachments. Known simplifications against mailparser: textAsHtml links only URLs with a scheme, "www." and email
// addresses (mailparser also links bare domains and @mentions via linkify-it), and named HTML entities cover Latin-1
// and the HTML 4 special characters (other characters become numeric references).
import { randomBytes } from 'node:crypto';
import { domainToASCII, domainToUnicode } from 'node:url';
import { convert as htmlToText } from 'html-to-text';
import { lookupMimeType } from '../../binary.js';

// ---------------------------------------------------------------------------------------------------------------
// Addresses (behavior of nodemailer lib/addressparser)
// ---------------------------------------------------------------------------------------------------------------

export interface MailAddress {
  address?: string;
  name: string;
  group?: MailAddress[];
}

type Token = { type: 'text' | 'quoted' | 'comment' | 'angle'; value: string } | { type: 'comma' | 'colon' | 'semicolon' };

function tokenizeAddresses(input: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  const flush = () => {
    if (text.trim()) tokens.push({ type: 'text', value: text.trim() });
    text = '';
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      flush();
      let v = '';
      for (i++; i < input.length && input[i] !== '"'; i++) {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        v += input[i];
      }
      tokens.push({ type: 'quoted', value: v });
    } else if (c === '(') {
      flush();
      let v = '';
      let depth = 1;
      for (i++; i < input.length; i++) {
        if (input[i] === '\\' && i + 1 < input.length) {
          v += input[++i];
          continue;
        }
        if (input[i] === '(') depth++;
        if (input[i] === ')' && --depth === 0) break;
        v += input[i];
      }
      tokens.push({ type: 'comment', value: v.trim() });
    } else if (c === '<') {
      flush();
      let v = '';
      for (i++; i < input.length && input[i] !== '>'; i++) v += input[i];
      tokens.push({ type: 'angle', value: v.trim() });
    } else if (c === ',') {
      flush();
      tokens.push({ type: 'comma' });
    } else if (c === ';') {
      flush();
      tokens.push({ type: 'semicolon' });
    } else if (c === ':') {
      flush();
      tokens.push({ type: 'colon' });
    } else {
      text += c;
    }
  }
  flush();
  return tokens;
}

const EMAIL_WORD = /^[^@\s]+@[^@\s]+$/;

/** One address from the tokens between separators */
function addressFromTokens(tokens: Token[]): MailAddress | undefined {
  const words: string[] = [];
  const comments: string[] = [];
  let address: string | undefined;
  for (const t of tokens) {
    if (t.type === 'angle') address = t.value;
    else if (t.type === 'comment') comments.push(t.value);
    else if (t.type === 'text' || t.type === 'quoted') {
      if (t.type === 'text') words.push(...t.value.split(/\s+/).filter(Boolean));
      else words.push(t.value);
    }
  }
  if (address === undefined) {
    // The last word that looks like an email address becomes the address
    for (let i = words.length - 1; i >= 0; i--) {
      if (EMAIL_WORD.test(words[i]) && !tokens.some((t) => t.type === 'quoted' && t.value === words[i])) {
        address = words.splice(i, 1)[0];
        break;
      }
    }
  }
  let name = words.join(' ').trim();
  if (!name && comments.length) name = comments.join(' ');
  if (address === undefined && !name) return undefined;
  return { address: address ?? '', name };
}

/** Parse an address list like nodemailer addressparser: names, quoted names, comments, groups */
export function parseAddressList(input: string): MailAddress[] {
  const tokens = tokenizeAddresses(input ?? '');
  const out: MailAddress[] = [];
  let current: Token[] = [];
  let group: MailAddress | undefined;
  const push = (entry: MailAddress | undefined) => {
    if (!entry) return;
    if (group) group.group!.push(entry);
    else out.push(entry);
  };
  for (const t of tokens) {
    if (t.type === 'colon' && !group) {
      const name = current
        .filter((x): x is Extract<Token, { value: string }> => 'value' in x)
        .map((x) => x.value)
        .join(' ')
        .trim();
      group = { name, group: [] };
      current = [];
    } else if (t.type === 'comma' || (t.type === 'semicolon' && !group)) {
      push(addressFromTokens(current));
      current = [];
    } else if (t.type === 'semicolon' && group) {
      push(addressFromTokens(current));
      out.push(group);
      group = undefined;
      current = [];
    } else {
      current.push(t);
    }
  }
  push(addressFromTokens(current));
  if (group) out.push(group);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Encoded words and charsets
// ---------------------------------------------------------------------------------------------------------------

/** Decode bytes with a MIME charset (unknown charsets as UTF-8) */
export function decodeCharset(data: Buffer, charset: string | false | undefined): string {
  const cs = String(charset || 'utf-8').trim().toLowerCase();
  const plain = cs.replace(/[^a-z0-9]+/g, '');
  if (['utf8', 'ascii', 'usascii'].includes(plain)) return data.toString('utf8');
  if (['latin1', 'iso88591', 'l1'].includes(plain)) return data.toString('latin1');
  try {
    return new TextDecoder(cs === 'ks_c_5601-1987' ? 'euc-kr' : cs).decode(data);
  } catch {
    return data.toString('utf8');
  }
}

function decodeQ(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '_') bytes.push(0x20);
    else if (c === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([QqBb])\?([^?]*)\?=/g;

/** RFC 2047 encoded words (libmime decodeWords): adjacent words of the same charset are joined before decoding */
export function decodeWords(value: string): string {
  if (!value || !value.includes('=?')) return value;
  // Whitespace between two encoded words is not part of the text
  const joined = value.replace(/(=\?[^?\s]+\?[QqBb]\?[^?]*\?=)\s+(?==\?[^?\s]+\?[QqBb]\?[^?]*\?=)/g, '$1');
  let out = '';
  let last = 0;
  let pending: { charset: string; bytes: Buffer[] } | undefined;
  const flush = () => {
    if (pending) out += decodeCharset(Buffer.concat(pending.bytes), pending.charset);
    pending = undefined;
  };
  for (const m of joined.matchAll(ENCODED_WORD)) {
    const between = joined.slice(last, m.index);
    if (between) {
      flush();
      out += between;
    }
    const charset = m[1].split('*')[0];
    const bytes = m[2].toUpperCase() === 'B' ? Buffer.from(m[3], 'base64') : decodeQ(m[3]);
    if (pending && pending.charset.toLowerCase() === charset.toLowerCase()) pending.bytes.push(bytes);
    else {
      flush();
      pending = { charset, bytes: [bytes] };
    }
    last = m.index + m[0].length;
  }
  flush();
  return out + joined.slice(last);
}

/** Q or B like nodemailer _getTextEncoding: more Latin letters than other characters prefers Q */
function preferredEncoding(value: string): 'Q' | 'B' {
  // eslint-disable-next-line no-control-regex -- MIME rules are defined on control characters
  const nonLatin = (value.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\u0080-\uFFFF]/g) ?? []).length;
  const latin = (value.match(/[a-z]/gi) ?? []).length;
  return nonLatin < latin ? 'Q' : 'B';
}

/** Encode a whole value as encoded words of at most maxLength characters of payload */
function encodeWord(value: string, encoding: 'Q' | 'B', maxLength = 52): string {
  const words: string[] = [];
  if (encoding === 'B') {
    let chunk = '';
    for (const ch of value) {
      if (Buffer.byteLength(chunk + ch) > Math.floor((maxLength / 4) * 3) && chunk) {
        words.push(chunk);
        chunk = '';
      }
      chunk += ch;
    }
    if (chunk) words.push(chunk);
    return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(' ');
  }
  let chunk = '';
  for (const ch of value) {
    let piece = '';
    if (/[A-Za-z0-9!*+\-/]/.test(ch)) piece = ch;
    else if (ch === ' ') piece = '_';
    else for (const b of Buffer.from(ch)) piece += `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    if (chunk.length + piece.length > maxLength && chunk) {
      words.push(chunk);
      chunk = '';
    }
    chunk += piece;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?Q?${w}?=`).join(' ');
}

/** Header text: unchanged if printable ASCII, otherwise encoded as a whole (nodemailer encodeWords with encodeAll) */
function encodeWords(value: string): string {
  return /[^\t\x20-\x7e]/.test(value) ? encodeWord(value, preferredEncoding(value)) : value;
}

/** Fold a header line at whitespace to at most `length` characters per line */
function foldLine(line: string, length = 76): string {
  if (line.length <= length) return line;
  const out: string[] = [];
  let rest = line;
  while (rest.length > length) {
    let cut = rest.lastIndexOf(' ', length);
    if (cut <= 0) cut = rest.indexOf(' ', length);
    if (cut <= 0) break;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Structured header values (Content-Type, Content-Disposition)
// ---------------------------------------------------------------------------------------------------------------

export interface HeaderValue {
  value: string;
  params: Record<string, string>;
}

/** Parse "value; key=value; key*0*=charset''..." (libmime parseHeaderValue including RFC 2231 continuations) */
export function parseHeaderValue(input: string): HeaderValue {
  const result: HeaderValue = { value: '', params: {} };
  const raw: Record<string, string> = {};
  let key: string | false = false;
  let value = '';
  let stage: 'value' | 'key' = 'value';
  let quote = false;
  let escaped = false;
  const assign = () => {
    if (key === false) result.value = value.trim();
    else raw[key] = value.trim();
  };
  for (const c of input ?? '') {
    if (stage === 'key') {
      if (c === '=') {
        key = value.trim().toLowerCase();
        stage = 'value';
        value = '';
        continue;
      }
      value += c;
      continue;
    }
    if (escaped) value += c;
    else if (c === '\\') {
      escaped = true;
      continue;
    } else if (quote && c === '"') quote = false;
    else if (!quote && c === '"') quote = true;
    else if (!quote && c === ';') {
      assign();
      stage = 'key';
      value = '';
    } else value += c;
    escaped = false;
  }
  if (stage === 'value') assign();
  else if (value.trim()) raw[value.trim().toLowerCase()] = '';
  // RFC 2231: name*0*=utf-8''%C3%A4, name*1*=..., name*=...
  const split: Record<string, { charset?: string; values: string[]; encoded: boolean[] }> = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = /(\*(\d+)|\*(\d+)\*|\*)$/.exec(k);
    if (!m) {
      result.params[k] = v;
      continue;
    }
    const name = k.slice(0, m.index);
    const nr = Number(m[2] ?? m[3]) || 0;
    const entry = (split[name] ??= { values: [], encoded: [] });
    const encoded = m[0].endsWith('*');
    let text = v;
    const cs = nr === 0 && encoded ? /^([^']*)'[^']*'(.*)$/.exec(v) : null;
    if (cs) {
      entry.charset = cs[1] || 'iso-8859-1';
      text = cs[2];
    }
    entry.values[nr] = text;
    entry.encoded[nr] = encoded;
  }
  for (const [name, entry] of Object.entries(split)) {
    if (!entry.charset) {
      result.params[name] = entry.values.map((x) => x ?? '').join('');
      continue;
    }
    const bytes: number[] = [];
    entry.values.forEach((text, i) => {
      const t = text ?? '';
      for (let j = 0; j < t.length; j++) {
        if (entry.encoded[i] && t[j] === '%' && /^[0-9a-f]{2}$/i.test(t.slice(j + 1, j + 3))) {
          bytes.push(parseInt(t.slice(j + 1, j + 3), 16));
          j += 2;
        } else bytes.push(...Buffer.from(t[j]));
      }
    });
    result.params[name] = decodeCharset(Buffer.from(bytes), entry.charset);
  }
  return result;
}

/** Parameter value as token, quoted string or RFC 2231 (non-ASCII) */
function buildParam(key: string, value: string): string {
  if (/[^\x20-\x7e]/.test(value)) {
    const encoded = [...Buffer.from(value)].map((b) => (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
    return `${key}*=utf-8''${encoded}`;
  }
  return /[\s"\\;:/=(),<>@[\]?]|^-/.test(value) || value === '' ? `${key}="${value.replace(/(["\\])/g, '\\$1')}"` : `${key}=${value}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Transfer encodings
// ---------------------------------------------------------------------------------------------------------------

/** Base64 in lines of 76 characters */
function base64Lines(data: Buffer): string {
  return (data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** Quoted-printable (RFC 2045): CRLF line breaks stay, soft breaks after at most 76 characters */
function quotedPrintable(text: string): string {
  return text
    .split('\r\n')
    .map((line) => {
      const bytes = Buffer.from(line);
      let encoded = '';
      bytes.forEach((b, i) => {
        const trailingSpace = (b === 0x20 || b === 0x09) && i === bytes.length - 1;
        encoded += (b === 0x09 || (b >= 0x20 && b <= 0x7e && b !== 0x3d)) && !trailingSpace ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      });
      const parts: string[] = [];
      while (encoded.length > 76) {
        let cut = 75;
        // do not split an "=XX" sequence
        const eq = encoded.lastIndexOf('=', cut);
        if (eq > cut - 3) cut = eq;
        parts.push(`${encoded.slice(0, cut)}=`);
        encoded = encoded.slice(cut);
      }
      parts.push(encoded);
      return parts.join('\r\n');
    })
    .join('\r\n');
}

function decodeQuotedPrintable(text: string): Buffer {
  const cleaned = text.replace(/[\t ]+$/gm, '').replace(/=(?:\r?\n|$)/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned.charCodeAt(i);
    if (cleaned[i] === '=' && /^[0-9a-f]{2}$/i.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c & 0xff);
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------------------------------------------
// Composing
// ---------------------------------------------------------------------------------------------------------------

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** Fields as GenericFunctions.js encodeEmail passes them to nodemailer (empty strings are left out) */
export interface MailOptions {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
  /** Fixed values for tests */
  date?: Date;
  messageId?: string;
  boundary?: string;
}

interface Part {
  headers: Array<[string, string]>;
  contentType: string;
  /** Leaf: content and encoding */
  content?: Buffer | string;
  filename?: string;
  children?: Part[];
  boundary?: string;
}

function setHeader(part: Part, key: string, value: string): void {
  const existing = part.headers.find(([k]) => k === key);
  if (existing) existing[1] = value;
  else part.headers.push([key, value]);
}

/** nodemailer _convertAddresses: punycode domains, quoted or encoded names, groups */
function formatAddresses(list: MailAddress[]): string {
  const encodeName = (name: string) => {
    if (/^[\w ]*$/.test(name)) return name;
    if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/([\\"])/g, '\\$1')}"`;
    return encodeWord(name, preferredEncoding(name));
  };
  const normalize = (address: string) => {
  // eslint-disable-next-line no-control-regex -- MIME rules are defined on control characters
    const a = address.replace(/[\x00-\x1F<>]+/g, ' ').trim();
    const at = a.lastIndexOf('@');
    if (at < 0) return a;
    let user = a.slice(0, at);
    const domain = a.slice(at + 1);
    if (user.includes(' ')) user = `${user.startsWith('"') ? '' : '"'}${user}${user.endsWith('"') ? '' : '"'}`;
    return `${user}@${domainToASCII(domain.toLowerCase()) || domain}`;
  };
  return list
    .map((a) => {
      if (a.address) {
        const address = normalize(a.address);
        if (!a.name) return address.includes(' ') ? `<${address}>` : address;
        return `${encodeName(a.name)} <${address}>`;
      }
      if (a.group) return `${encodeName(a.name)}:${a.group.length ? formatAddresses(a.group).trim() : ''};`;
      return '';
    })
    .filter(Boolean)
    .join(', ');
}

function bracketId(value: string): string {
  let v = value.replace(/\r?\n|\r/g, ' ');
  if (!v.startsWith('<')) v = `<${v}`;
  if (!v.endsWith('>')) v = `${v}>`;
  return v;
}

/** Transfer encoding and encoded body of a leaf (nodemailer getTransferEncoding) */
function encodeLeaf(part: Part): { encoding?: string; body: string } {
  const content = part.content ?? '';
  const empty = typeof content === 'string' ? content === '' : content.length === 0;
  if (empty) return { body: '' };
  if (/^text\//i.test(part.contentType) && typeof content === 'string') {
    const text = content.replace(/\r?\n|\r/g, '\r\n');
  // eslint-disable-next-line no-control-regex -- MIME rules are defined on control characters
    const plain = !/[^\x09\x0a\x0d\x20-\x7e]/.test(text);
    const longLines = text.split('\r\n').some((l) => l.length > 76);
    if (plain && !longLines) return { encoding: '7bit', body: text };
    if (preferredEncoding(text) === 'Q') return { encoding: 'quoted-printable', body: quotedPrintable(text) };
    return { encoding: 'base64', body: base64Lines(Buffer.from(text)) };
  }
  const data = typeof content === 'string' ? Buffer.from(content) : content;
  return { encoding: 'base64', body: base64Lines(data) };
}

function serialize(part: Part, isRoot: boolean, root: { date: Date; messageId: string }): string {
  let encoded: { encoding?: string; body: string } | undefined;
  if (!part.children) {
    encoded = encodeLeaf(part);
    if (encoded.encoding) setHeader(part, 'Content-Transfer-Encoding', encoded.encoding);
  }
  if (part.filename && !part.headers.some(([k]) => k === 'Content-Disposition')) setHeader(part, 'Content-Disposition', 'attachment');
  if (isRoot) {
    if (!part.headers.some(([k]) => k === 'Date')) setHeader(part, 'Date', root.date.toUTCString().replace(/GMT/, '+0000'));
    if (!part.headers.some(([k]) => k === 'Message-ID')) setHeader(part, 'Message-ID', root.messageId);
    setHeader(part, 'MIME-Version', '1.0');
    const i = part.headers.findIndex(([k]) => k === 'Content-Type');
    if (i !== -1) part.headers.push(...part.headers.splice(i, 1));
  }
  const lines = part.headers.map(([key, value]) => {
    let v = value;
    if (key === 'Content-Type') {
      const parsed = parseHeaderValue(value);
      v = parsed.value;
      if (part.boundary) v += `; ${buildParam('boundary', part.boundary)}`;
      for (const [k, p] of Object.entries(parsed.params)) v += `; ${buildParam(k, p)}`;
      if (part.filename) {
        let name = encodeWords(part.filename);
        if (name !== part.filename || /[\s'"\\;:/=(),<>@[\]?]|^-/.test(name)) name = `"${name}"`;
        v += `; name=${name}`;
      }
    } else if (key === 'Content-Disposition') {
      v = parseHeaderValue(value).value;
      if (part.filename) v += `; ${buildParam('filename', part.filename)}`;
    }
    return foldLine(`${key}: ${v}`);
  });
  let out = `${lines.join('\r\n')}\r\n\r\n`;
  if (part.children) {
    for (const child of part.children) out += `--${part.boundary}\r\n${serialize(child, false, root)}\r\n`;
    out += `--${part.boundary}--\r\n`;
  } else {
    // nodemailer ends a single-part message with a line break
    out += encoded!.body + (isRoot && encoded!.body ? '\r\n' : '');
  }
  return out;
}

/**
 * Build the message like nodemailer MailComposer.compile with the options of GenericFunctions.js encodeEmail
 * (keepBcc). Text and HTML become multipart/alternative, attachments multipart/mixed; a message without text and with
 * exactly one attachment consists of the attachment alone (as in nodemailer).
 */
export function composeMail(o: MailOptions): Buffer {
  const base = o.boundary ?? randomBytes(8).toString('hex');
  let counter = 0;
  const boundaryOf = () => `--_NmP-${base}-Part_${counter}`;
  const node = (contentType: string): Part => {
    counter++;
    const part: Part = { headers: [['Content-Type', contentType]], contentType };
    if (/^multipart\//i.test(contentType)) part.boundary = boundaryOf();
    return part;
  };
  const alternatives: Array<{ contentType: string; content: string }> = [];
  if (o.text) alternatives.push({ contentType: 'text/plain; charset=utf-8', content: o.text });
  if (o.html) alternatives.push({ contentType: 'text/html; charset=utf-8', content: o.html });
  const attachments = (o.attachments ?? []).map((a) => ({
    contentType: a.contentType || lookupMimeType(a.filename || 'bin') || 'application/octet-stream',
    filename: a.filename,
    content: a.content,
  }));
  const contentNode = (el: { contentType: string; content: Buffer | string; filename?: string }, isAttachment: boolean): Part => {
    const part = node(el.contentType);
    part.content = el.content;
    if (isAttachment) {
      part.filename = el.filename;
      setHeader(part, 'Content-Transfer-Encoding', 'base64');
      setHeader(part, 'Content-Disposition', 'attachment');
    }
    return part;
  };
  const useAlternative = alternatives.length > 1;
  const useMixed = attachments.length > 1 || (alternatives.length > 0 && attachments.length === 1);
  const alternative = () => {
    const part = node('multipart/alternative');
    part.children = alternatives.map((a) => contentNode(a, false));
    return part;
  };
  let root: Part;
  if (useMixed) {
    root = node('multipart/mixed');
    root.children = [];
    if (useAlternative) root.children.push(alternative());
    else for (const a of alternatives) root.children.push(contentNode(a, false));
    for (const a of attachments) root.children.push(contentNode(a, true));
  } else if (useAlternative) {
    root = alternative();
  } else if (alternatives.length) {
    root = contentNode(alternatives[0], false);
  } else if (attachments.length) {
    root = contentNode(attachments[0], true);
  } else {
    root = contentNode({ contentType: 'text/plain', content: '' }, false);
  }
  // Root headers in nodemailer order; empty values are skipped
  const addresses = (v?: string) => (v ? formatAddresses(parseAddressList(v)) : '');
  const headerValues: Array<[string, string]> = [
    ['From', addresses(o.from)],
    ['To', addresses(o.to)],
    ['Cc', addresses(o.cc)],
    ['Bcc', addresses(o.bcc)],
    ['Reply-To', addresses(o.replyTo)],
    ['In-Reply-To', o.inReplyTo ? bracketId(o.inReplyTo) : ''],
    [
      'References',
      o.references
        ? o.references
            .replace(/\r?\n|\r/g, ' ')
            .trim()
            .replace(/<[^>]*>/g, (s) => s.replace(/\s/g, ''))
            .split(/\s+/)
            .map(bracketId)
            .join(' ')
        : '',
    ],
    ['Subject', o.subject ? encodeWords(o.subject.replace(/\r?\n|\r/g, ' ')) : ''],
  ];
  for (const [key, value] of headerValues) if (value.trim()) setHeader(root, key, value);
  const fromAddress = parseAddressList(o.from ?? '').find((a) => a.address)?.address;
  const messageId = o.messageId ?? `<${[2, 2, 2, 6].reduce((prev, len) => `${prev}-${randomBytes(len).toString('hex')}`, randomBytes(4).toString('hex'))}@${(fromAddress || 'localhost').split('@').pop()}>`;
  setHeader(root, 'Message-ID', messageId);
  return Buffer.from(serialize(root, true, { date: o.date ?? new Date(), messageId }), 'utf8');
}

/** base64url without padding (GenericFunctions.js encodeEmail) */
export function toBase64Url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------------------------------------------
// HTML helpers (he.encode with useNamedReferences, textToHtml of mailparser)
// ---------------------------------------------------------------------------------------------------------------

const LATIN1_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
    ' ',
  );
const SPECIAL_NAMES: Record<number, string> = {
  0x26: 'amp', 0x3c: 'lt', 0x3e: 'gt', 0x22: 'quot', 0x27: 'apos', 0x60: 'grave',
  0x152: 'OElig', 0x153: 'oelig', 0x160: 'Scaron', 0x161: 'scaron', 0x178: 'Yuml', 0x192: 'fnof', 0x2c6: 'circ', 0x2dc: 'tilde',
  0x2002: 'ensp', 0x2003: 'emsp', 0x2009: 'thinsp', 0x200c: 'zwnj', 0x200d: 'zwj', 0x200e: 'lrm', 0x200f: 'rlm', 0x2013: 'ndash',
  0x2014: 'mdash', 0x2018: 'lsquo', 0x2019: 'rsquo', 0x201a: 'sbquo', 0x201c: 'ldquo', 0x201d: 'rdquo', 0x201e: 'bdquo',
  0x2020: 'dagger', 0x2021: 'Dagger', 0x2022: 'bull', 0x2026: 'hellip', 0x2030: 'permil', 0x2032: 'prime', 0x2033: 'Prime',
  0x2039: 'lsaquo', 0x203a: 'rsaquo', 0x20ac: 'euro', 0x2122: 'trade',
};
LATIN1_NAMES.forEach((name, i) => (SPECIAL_NAMES[0xa0 + i] = name));

/** he.encode without named references: only these characters get a name */
const BASIC_NAMES: Record<number, string> = { 0x26: 'amp', 0x3c: 'lt', 0x3e: 'gt', 0x22: 'quot' };

/**
 * Encode text for HTML like he.encode: the special characters and everything outside printable ASCII (line breaks
 * stay); `named` like the option useNamedReferences
 */
export function encodeHtml(text: string, named = true): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const name = named ? SPECIAL_NAMES[cp] : BASIC_NAMES[cp];
    if (name) out += `&${name};`;
    else if (!named && (cp === 0x27 || cp === 0x60)) out += `&#x${cp.toString(16)};`;
    else if (cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0x7e)) out += ch;
    else out += `&#x${cp.toString(16).toUpperCase()};`;
  }
  return out;
}

const LINK = /\b(?:(?:https?|git):\/\/|mailto:|www\.)[^\s<>"]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Trailing punctuation does not belong to a link; a closing parenthesis only if unbalanced */
function trimLink(link: string): string {
  let l = link;
  for (;;) {
    const last = l.at(-1);
    if (last && '.,;:!?\'"'.includes(last)) l = l.slice(0, -1);
    else if (last === ')' && (l.match(/\(/g) ?? []).length < (l.match(/\)/g) ?? []).length) l = l.slice(0, -1);
    else return l;
  }
}

/** mailparser textToHtml: links, HTML encoding, paragraphs for blank lines, <br/> for line breaks */
export function textToHtml(str: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of str.matchAll(LINK)) {
    const text = trimLink(m[0]);
    if (!text || m.index < last) continue;
    parts.push(encodeHtml(str.slice(last, m.index)));
    let url = text;
    if (/^www\./i.test(text)) url = `http://${text}`;
    else if (!/^[a-z]+:/i.test(text) && text.includes('@')) url = `mailto:${text}`;
    parts.push(`<a href="${url}">${text}</a>`);
    last = m.index + text.length;
  }
  parts.push(encodeHtml(str.slice(last)));
  const encoded = parts.join('');
  return `<p>${encoded
    .replace(/\r?\n/g, '\n')
    .trim()
    .replace(/[ \t]+$/gm, '')
    .trim()
    .replace(/\n\n+/g, '</p><p>')
    .trim()
    .replace(/\n/g, '<br/>')}</p>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

export interface HeaderLine {
  key: string;
  line: string;
}

export interface AddressObject {
  value: MailAddress[];
  html: string;
  text: string;
}

export interface ParsedAttachment {
  content: Buffer;
  contentType: string;
  filename?: string;
  contentDisposition?: string;
  contentId?: string;
  cid?: string;
  related?: boolean;
}

/** Result like mailparser simpleParser (subset that the reference uses) */
export interface ParsedMail {
  headerLines: HeaderLine[];
  html: string | false;
  text?: string;
  textAsHtml?: string;
  subject?: string;
  references?: string | string[];
  date?: Date;
  to?: AddressObject | AddressObject[];
  from?: AddressObject;
  cc?: AddressObject | AddressObject[];
  bcc?: AddressObject | AddressObject[];
  messageId?: string;
  inReplyTo?: string;
  replyTo?: AddressObject;
  attachments: ParsedAttachment[];
}

interface Node {
  headerLines: HeaderLine[];
  contentType: string;
  charset: string | false;
  disposition: string;
  filename?: string;
  encoding: string;
  flowed: boolean;
  delSp: boolean;
  isAttachment: boolean;
  root: boolean;
  showMeta: boolean;
  parent?: Node;
  children: Node[];
  body?: string;
  textContent?: string;
  headerMap?: Map<string, unknown>;
}

const TEXT_TYPES = ['text/plain', 'text/html', 'message/delivery-status'];

/** mailsplit Headers._parseHeaders: lines in "binary" form, folded lines joined with CRLF */
function parseHeaderLines(block: string): HeaderLine[] {
  const lines = block.replace(/[\r\n]+$/, '').split(/\r?\n/);
  const out: HeaderLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1].line += `\r\n${line}`;
      continue;
    }
    if (i === 0 && /^From /i.test(line)) continue;
    if (!line) continue;
    out.push({ key: line.slice(0, Math.max(line.indexOf(':'), 0)).trim().toLowerCase(), line });
  }
  return out;
}

/** libmime decodeHeader: value after the colon, unfolded */
function headerValue(line: string): string {
  const unfolded = line.replace(/(?:\r?\n|\r)[ \t]*/g, ' ').trim();
  const m = /^\s*([^:]+):(.*)$/.exec(unfolded);
  return (m?.[2] ?? '').trim();
}

const firstHeader = (lines: HeaderLine[], key: string) => {
  const line = lines.find((l) => l.key === key);
  return line ? headerValue(line.line) : '';
};

/** Split a binary string at the first blank line into header block and body */
function splitHead(raw: string): { head: string; body: string } {
  if (/^\r?\n/.test(raw)) return { head: '', body: raw.replace(/^\r?\n/, '') };
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** Parts of a multipart body; the line break before a boundary belongs to the boundary (RFC 2046) */
function splitMultipart(body: string, boundary: string): string[] {
  const lines = body.split(/(\r?\n)/);
  const parts: string[] = [];
  let current: string[] | undefined;
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    const eol = lines[i + 1] ?? '';
    const trimmed = line.replace(/[ \t]+$/, '');
    if (trimmed === `--${boundary}` || trimmed === `--${boundary}--`) {
      if (current) parts.push(current.join('').replace(/\r?\n$/, ''));
      if (trimmed === `--${boundary}--`) return parts;
      current = [];
      continue;
    }
    if (current) current.push(line + eol);
  }
  if (current) parts.push(current.join(''));
  return parts;
}

function parseNode(raw: string, parent: Node | undefined, showMeta: boolean): Node {
  const { head, body } = splitHead(raw);
  const headerLines = parseHeaderLines(head);
  const dispositionValue = parseHeaderValue(firstHeader(headerLines, 'content-disposition'));
  let contentHeader: string;
  if (headerLines.some((l) => l.key === 'content-type')) contentHeader = firstHeader(headerLines, 'content-type');
  else {
    const ext = dispositionValue.params.filename ? (/\.([^./\\]+)$/.exec(dispositionValue.params.filename)?.[1] ?? '') : '';
    contentHeader = (ext && lookupMimeType(`x.${ext}`)) || (/^attachment$/i.test(dispositionValue.value) ? 'application/octet-stream' : 'text/plain');
  }
  const ct = parseHeaderValue(contentHeader);
  let contentType = ct.value.toLowerCase().trim();
  if (!contentType && !parent) contentType = 'text/plain';
  const encoding = firstHeader(headerLines, 'content-transfer-encoding').replace(/\(.*\)/g, '').toLowerCase().trim();
  let disposition = decodeWords(dispositionValue.value.toLowerCase().trim());
  const filenameRaw = dispositionValue.params.filename || ct.params.name;
  const node: Node = {
    headerLines,
    contentType,
    charset: ct.params.charset || false,
    disposition: '',
    filename: filenameRaw ? decodeWords(filenameRaw) : undefined,
    encoding,
    flowed: (ct.params.format ?? '').toLowerCase().trim() === 'flowed',
    delSp: (ct.params.delsp ?? '').toLowerCase().trim() === 'yes',
    isAttachment: false,
    root: !parent,
    showMeta,
    parent,
    children: [],
  };
  const multipart = contentType.startsWith('multipart/') && ct.params.boundary;
  if (multipart) {
    for (const child of splitMultipart(body, ct.params.boundary)) node.children.push(parseNode(child, node, false));
    return node;
  }
  if (contentType === 'message/rfc822' && (!encoding || ['7bit', '8bit', 'binary'].includes(encoding)) && disposition === 'inline') {
    // Embedded message: parsed as a child whose headers are shown in the text (showMeta)
    node.children.push(parseNode(body, node, true));
    return node;
  }
  if (disposition && !['attachment', 'inline'].includes(disposition)) disposition = 'attachment';
  node.disposition = !disposition && !TEXT_TYPES.includes(contentType) ? 'attachment' : disposition || 'inline';
  node.isAttachment = !TEXT_TYPES.includes(contentType) || node.disposition !== 'inline';
  node.body = body;
  return node;
}

function decodeBody(node: Node): Buffer {
  const body = node.body ?? '';
  if (node.encoding === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (node.encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return Buffer.from(body, 'latin1');
}

/** format=flowed (RFC 3676): lines ending in a space continue on the next line, space stuffing removed */
function decodeFlowed(text: string, delSp: boolean): string {
  const lines = text.split(/\r?\n/);
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith(' ')) line = line.slice(1);
    const soft = line.endsWith(' ') && line !== '-- ';
    if (soft) {
      out += delSp ? line.slice(0, -1) : line;
    } else {
      out += line + (i < lines.length - 1 ? '\n' : '');
    }
  }
  return out;
}

function decodeAddresses(list: MailAddress[]): MailAddress[] {
  const out: MailAddress[] = [];
  for (const a of list) {
    const name = (a.name || '').trim();
    if (!a.address && /^(=\?([^?]+)\?[Bb]\?[^?]*\?=)(\s*=\?([^?]+)\?[Bb]\?[^?]*\?=)*$/.test(name) && !a.group) {
      out.push(...parseAddressList(decodeWords(name)).map((x) => ({ ...x, name: (x.name || '').trim() })));
      continue;
    }
    const entry: MailAddress = { ...a, name: name ? decodeWords(name) : '' };
    if (entry.address && /@xn--/.test(entry.address)) {
      const at = entry.address.lastIndexOf('@');
      entry.address = entry.address.slice(0, at + 1) + (domainToUnicode(entry.address.slice(at + 1)) || entry.address.slice(at + 1));
    }
    if (entry.group) entry.group = decodeAddresses(entry.group);
    out.push(entry);
  }
  return out;
}

function addressesHtml(list: MailAddress[]): string {
  return list
    .map((a) => {
      let s = '<span class="mp_address_group">';
      if (a.name) s += `<span class="mp_address_name">${encodeHtml(a.name, false)}${a.group ? ': ' : ''}</span>`;
      if (a.address) {
        const link = `<a href="mailto:${encodeHtml(a.address, false)}" class="mp_address_email">${encodeHtml(a.address, false)}</a>`;
        s += a.name ? ` &lt;${link}&gt;` : link;
      }
      if (a.group) s += `${addressesHtml(a.group)};`;
      return `${s}</span>`;
    })
    .join(', ');
}

function addressesText(list: MailAddress[]): string {
  return list
    .map((a) => {
      let s = '';
      if (a.name) s += `"${a.name}"${a.group ? ': ' : ''}`;
      if (a.address) s += a.name ? ` <${a.address}>` : a.address;
      if (a.group) s += `${addressesText(a.group)};`;
      return s;
    })
    .join(', ');
}

/** Address list with mailparser key order (address before name) */
function orderAddresses(list: MailAddress[]): MailAddress[] {
  return list.map((a) => (a.group ? { name: a.name, group: orderAddresses(a.group) } : { address: a.address ?? '', name: a.name }));
}

function ensureMessageId(value: string): string | false {
  if (!value.length) return false;
  let v = value;
  if (!v.startsWith('<')) v = `<${v}`;
  if (!v.endsWith('>')) v = `${v}>`;
  return v;
}

const SINGLE_KEYS = ['message-id', 'content-id', 'from', 'sender', 'in-reply-to', 'reply-to', 'subject', 'date', 'content-disposition', 'content-type', 'content-transfer-encoding', 'priority', 'mime-version', 'content-description', 'precedence', 'errors-to'];

/** mailparser processHeaders for the fields simpleParser takes over (plus content-id for attachments) */
function processHeaders(lines: HeaderLine[]): Map<string, unknown> {
  const headers = new Map<string, unknown[]>();
  for (const { key, line } of lines) {
    let value: unknown = Buffer.from(headerValue(line), 'latin1').toString('utf8').trim();
    const text = value as string;
    switch (key) {
      case 'date': {
        const d = new Date(text);
        value = Number.isNaN(d.getTime()) ? new Date() : d;
        break;
      }
      case 'subject':
        value = decodeWords(text);
        break;
      case 'references':
        value = decodeWords(text)
          .split(/\s+/)
          .map((v) => ensureMessageId(v));
        break;
      case 'message-id':
      case 'in-reply-to':
        value = ensureMessageId(decodeWords(text));
        break;
      case 'from':
      case 'to':
      case 'cc':
      case 'bcc':
      case 'sender':
      case 'reply-to':
      case 'delivered-to':
      case 'return-path': {
        const list = orderAddresses(decodeAddresses(parseAddressList(text)));
        value = { value: list, html: addressesHtml(list), text: addressesText(list) };
        break;
      }
    }
    if (!value) continue;
    const existing = headers.get(key);
    if (!existing) headers.set(key, ([] as unknown[]).concat(value));
    else if (Array.isArray(value)) headers.set(key, existing.concat(value));
    else existing.push(value);
  }
  const out = new Map<string, unknown>();
  for (const [key, value] of headers) {
    if (SINGLE_KEYS.includes(key) && value.length) out.set(key, value[value.length - 1]);
    else out.set(key, value.length === 1 ? value[0] : value);
  }
  return out;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

/** Parse a message like mailparser simpleParser (input as string or bytes) */
export function parseMail(input: string | Buffer): ParsedMail {
  const raw = (typeof input === 'string' ? Buffer.from(input) : input).toString('latin1');
  const tree = parseNode(raw, undefined, false);
  const attachments: ParsedAttachment[] = [];
  let hasText = false;
  let hasHtml = false;
  walk(tree, (node) => {
    if (node.body === undefined) return;
    if (node.isAttachment) {
      let contentType = node.contentType;
      if (contentType === 'application/octet-stream' && node.filename) contentType = lookupMimeType(node.filename) ?? 'application/octet-stream';
      const attachment: ParsedAttachment = { content: decodeBody(node), contentType };
      if (node.disposition) attachment.contentDisposition = node.disposition;
      if (node.filename) attachment.filename = node.filename;
      const contentId = firstHeader(node.headerLines, 'content-id');
      if (contentId) {
        attachment.contentId = contentId;
        attachment.cid = contentId.trim().replace(/^<|>$/g, '').trim();
        for (let p = node.parent; p; p = p.parent) if (p.contentType === 'multipart/related') attachment.related = true;
      }
      attachments.push(attachment);
      return;
    }
    if (node.contentType === 'text/plain' || node.contentType === 'message/delivery-status') hasText = true;
    else if (node.contentType === 'text/html') hasHtml = true;
    let text = decodeCharset(decodeBody(node), node.charset || 'utf-8');
    if (node.flowed) text = decodeFlowed(text, node.delSp);
    node.textContent = text.replace(/\r?\n/g, '\n');
  });

  // getTextContent
  const text: string[] = [];
  const html: string[] = [];
  const process = (alternative: boolean, node: Node) => {
    if (node.showMeta) {
      node.headerMap ??= processHeaders(node.headerLines);
      const meta = ['From', 'Subject', 'Date', 'To', 'Cc', 'Bcc']
        .map((key) => {
          const v = node.headerMap!.get(key.toLowerCase());
          return v ? { key, value: Array.isArray(v) ? v[v.length - 1] : v } : undefined;
        })
        .filter((e): e is { key: string; value: unknown } => !!e);
      if (hasHtml) {
        html.push(
          `<table class="mp_head">${meta
            .map((e) => {
              let v: string;
              if (['From', 'To', 'Cc', 'Bcc'].includes(e.key)) v = (e.value as AddressObject).html;
              else if (e.key === 'Date') v = (e.value as Date).toUTCString();
              else if (e.key === 'Subject') v = `<strong>${encodeHtml(String(e.value), false)}</strong>`;
              else v = encodeHtml(String(e.value), false);
              return `<tr><td class="mp_head_key">${encodeHtml(e.key, false)}:</td><td class="mp_head_value">${v}<td></tr>`;
            })
            .join('\n')}<table>`,
        );
      }
      if (hasText) {
        text.push(
          `\n${meta
            .map((e) => {
              let v: unknown = e.value;
              if (['From', 'To', 'Cc', 'Bcc'].includes(e.key)) v = (e.value as AddressObject).text;
              else if (e.key === 'Date') v = (e.value as Date).toUTCString();
              return `${e.key}: ${String(v)}`;
            })
            .join('\n')}\n`,
        );
      }
    }
    if (node.textContent) {
      if (node.contentType === 'text/plain' || node.contentType === 'message/delivery-status') {
        text.push(node.textContent);
        if (!alternative && hasHtml) html.push(textToHtml(node.textContent));
      } else if (node.contentType === 'text/html') {
        if ((!alternative && hasText) || (node.root && !hasText)) text.push(htmlToText(node.textContent));
        html.push(node.textContent);
      }
    }
    const alt = alternative || node.contentType === 'multipart/alternative';
    for (const child of node.children) process(alt, child);
  };
  process(false, tree);

  const headers = processHeaders(tree.headerLines);
  const result: ParsedMail = { headerLines: tree.headerLines, html: false, attachments };
  let htmlText: string | false = false;
  if (html.length) htmlText = html.join('<br/>\n');
  const out = result as unknown as Record<string, unknown>;
  delete out.html;
  if (htmlText !== false) out.html = htmlText;
  if (text.length) {
    out.text = text.join('\n');
    out.textAsHtml = text.map((part) => textToHtml(part)).join('<br/>\n');
  }
  const fields: Array<[string, string]> = [
    ['subject', 'subject'],
    ['references', 'references'],
    ['date', 'date'],
    ['to', 'to'],
    ['from', 'from'],
    ['cc', 'cc'],
    ['bcc', 'bcc'],
    ['message-id', 'messageId'],
    ['in-reply-to', 'inReplyTo'],
    ['reply-to', 'replyTo'],
  ];
  for (const [key, field] of fields) if (headers.has(key)) out[field] = headers.get(key);
  // updateImageLinks: cid: references to image attachments become data URIs
  if (htmlText !== false) {
    out.html = htmlText.replace(/\bcid:([^'"\s]{1,256})/g, (match, cid: string) => {
      const a = attachments.find((x) => x.cid === cid && /^image\/[\w]+$/i.test(x.contentType));
      return a ? `data:${a.contentType};base64,${a.content.toString('base64')}` : match;
    });
  } else {
    out.html = false;
  }
  return result;
}

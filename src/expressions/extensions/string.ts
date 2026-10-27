// Extension functions for strings.
// Behavior rebuilt after the reference version 1.123.0 packages/workflow/src/extensions/string-extensions.ts
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { titleCase } from 'title-case';
import { transliterate } from 'transliteration';
import { ExpressionExtensionError } from '../../errors.js';
import { tryToParseDateTime } from '../../nodes/shared/utils.js';
import type { ExtensionFunction, ExtensionMap } from './types.js';
import { numberToDateTime } from './number.js';

const SUPPORTED_HASH = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha3'];

// Currency symbols according to xe.com (as in the reference), removed before number conversion
// Code points of the symbols (order as in the reference, it determines the alternatives in the regex)
const CURRENCY_CODE_POINTS: number[][] = [[0x4c, 0x65, 0x6b], [0x60b], [0x24], [0x192], [0x20bc], [0x42, 0x72], [0x42, 0x5a, 0x24], [0x24, 0x62], [0x4b, 0x4d], [0x50], [0x43b, 0x432], [0x52, 0x24], [0x17db], [0xa5], [0x20a1], [0x6b, 0x6e], [0x20b1], [0x4b, 0x10d], [0x6b, 0x72], [0x52, 0x44, 0x24], [0xa3], [0x20ac], [0xa2], [0x51], [0x4c], [0x46, 0x74], [0x20b9], [0x52, 0x70], [0xfdfc], [0x20aa], [0x4a, 0x24], [0x20a9], [0x20ad], [0x434, 0x435, 0x43d], [0x52, 0x4d], [0x20a8], [0x20ae], [0x4d, 0x54], [0x43, 0x24], [0x20a6], [0x42, 0x2f, 0x2e], [0x47, 0x73], [0x53, 0x2f, 0x2e], [0x7a, 0x142], [0x6c, 0x65, 0x69], [0x20bd], [0x414, 0x438, 0x43d, 0x2e], [0x53], [0x52], [0x43, 0x48, 0x46], [0x4e, 0x54, 0x24], [0xe3f], [0x54, 0x54, 0x24], [0x20ba], [0x20b4], [0x24, 0x55], [0x42, 0x73], [0x20ab], [0x5a, 0x24]];
const CURRENCY_REGEXP = new RegExp(
  `(${CURRENCY_CODE_POINTS.map((cp) => String.fromCodePoint(...cp).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`,
  'gu',
);

const DOMAIN_EXTRACT_REGEXP =
  /^(?:(?:https?|ftp):\/\/)?(?:mailto:)?(?:\/\/)?((?:www\.)?(?:(?:[-\w]+\.)+(?:[a-zA-Z]{2,}|xn--[a-zA-Z0-9]+)|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}))(?::\d+)?(?:\/[^\s?]*)?(?:\?[^\s#]*)?(?:#[^\s]*)?$/i;
const DOMAIN_REGEXP =
  /^(?:www\.)?((?:(?:[-\w]+\.)+(?:[a-zA-Z]{2,}|xn--[a-zA-Z0-9]+)|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}))(?::\d+)?(?:\/[^\s?]*)?(?:\?[^\s#]*)?(?:#[^\s]*)?$/i;
const EMAIL_REGEXP =
  /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@(?<domain>(\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;
const URL_REGEXP_EXACT =
  /^(?:(?:https?|ftp):\/\/)(?:www\.)?((?:(?:[-\w]+\.)+(?:[a-zA-Z]{2,}|xn--[a-zA-Z0-9]+)|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}))(?::\d+)?(?:\/[^\s?#]*)?(?:\?[^\s#]*)?(?=([^\s]+#.*)?)#?[^\s]*$/i;
const URL_REGEXP =
  /(?:(?:https?|ftp):\/\/)(?:www\.)?((?:(?:[-\w]+\.)+(?:[a-zA-Z]{2,}|xn--[a-zA-Z0-9]+)|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}))(?::\d+)?(?:\/[^\s?#]*)?(?:\?[^\s#]*)?(?=([^\s]+#.*)?)#?[^\s]*/i;
const CHAR_TEST_REGEXP = /\p{L}/u;
const PUNC_TEST_REGEXP = /[!?.]/;

const toBase64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const fromBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8');

function hash(value: string, args: unknown[]): string {
  const algorithm = (typeof args[0] === 'string' ? args[0] : 'md5').toLowerCase();
  switch (algorithm) {
    case 'base64':
      return toBase64(value);
    case 'md5':
      return createHash('md5').update(value, 'utf8').digest('hex');
    case 'sha1':
    case 'sha224':
    case 'sha256':
    case 'sha384':
    case 'sha512':
      return createHash(algorithm).update(value, 'utf8').digest('hex');
    case 'sha3':
      return createHash('sha3-512').update(value, 'utf8').digest('hex');
    default:
      throw new ExpressionExtensionError(
        `Unknown algorithm ${algorithm}. Available algorithms are: ${SUPPORTED_HASH.join()}, and Base64.`,
      );
  }
}

function removeMarkdown(value: string): string {
  let output = value;
  try {
    output = output.replace(/^([\s\t]*)([*\-+]|\d\.)\s+/gm, '$1');
    output = output.replace(/\n={2,}/g, '\n').replace(/~~/g, '').replace(/`{3}.*\n/g, '');
    output = output
      .replace(/<[\w|\s|=|'|"|:|(|)|,|;|/|0-9|.|-]+[>|\\>]/g, '')
      .replace(/^[=-]{2,}\s*$/g, '')
      .replace(/\[\^.+?\](: .*?$)?/g, '')
      .replace(/\s{0,2}\[.*?\]: .*?$/g, '')
      .replace(/!\[.*?\][[(].*?[\])]/g, '')
      .replace(/\[(.*?)\][[(].*?[\])]/g, '$1')
      .replace(/>/g, '')
      .replace(/^\s{1,2}\[(.*?)\]: (\S+)( ".*?")?\s*$/g, '')
      .replace(/^#{1,6}\s*([^#]*)\s*(#{1,6})?/gm, '$1')
      .replace(/([*_]{1,3})(\S.*?\S)\1/g, '$2')
      .replace(/(`{3,})(.*?)\1/gm, '$2')
      .replace(/^-{3,}\s*$/g, '')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\n{2,}/g, '\n\n');
  } catch {
    return value;
  }
  return output;
}

function toDate(value: string): Date {
  const date = new Date(Date.parse(value));
  if (date.toString() === 'Invalid Date') throw new ExpressionExtensionError('cannot convert to date');
  if (!/:/.test(value)) date.setHours(0, 0, 0);
  return date;
}

export function stringToDateTime(value: string, args: unknown[] = ['']): DateTime {
  try {
    const [valueFormat] = args as [string | undefined];
    if (valueFormat) {
      if (valueFormat === 'ms' || valueFormat === 's' || valueFormat === 'us' || valueFormat === 'excel') {
        return numberToDateTime(Number(value), [valueFormat]);
      }
      return DateTime.fromFormat(value, valueFormat);
    }
    return tryToParseDateTime(value);
  } catch {
    throw new ExpressionExtensionError('cannot convert to Luxon DateTime');
  }
}

function urlDecode(value: string, args: unknown[]): string {
  return args[0] ? decodeURI(value.toString()) : decodeURIComponent(value.toString());
}

function urlEncode(value: string, args: unknown[]): string {
  return args[0] ? encodeURI(value.toString()) : encodeURIComponent(value.toString());
}

function toInt(value: string, args: unknown[]): number {
  const int = parseInt(value.replace(CURRENCY_REGEXP, ''), args[0] as number | undefined);
  if (isNaN(int)) throw new ExpressionExtensionError('cannot convert to integer');
  return int;
}

function toFloat(value: string): number {
  if (value.includes(',')) throw new ExpressionExtensionError('cannot convert to float, expected . as decimal separator');
  const f = parseFloat(value.replace(CURRENCY_REGEXP, ''));
  if (isNaN(f)) throw new ExpressionExtensionError('cannot convert to float');
  return f;
}

function toNumber(value: string): number {
  const n = Number(value.replace(CURRENCY_REGEXP, ''));
  if (isNaN(n)) throw new ExpressionExtensionError('cannot convert to number');
  return n;
}

function quote(value: string, args: unknown[]): string {
  const q = (args[0] as string | undefined) ?? '"';
  return `${q}${value.replace(/\\/g, '\\\\').replace(new RegExp(`\\${q}`, 'g'), `\\${q}`)}${q}`;
}

function isNumeric(value: string): boolean {
  if (value.includes(' ')) return false;
  return !isNaN(value as unknown as number) && !isNaN(parseFloat(value));
}

function isEmail(value: string): boolean {
  const result = EMAIL_REGEXP.test(value);
  if (result && value.includes(' ')) return false;
  return result;
}

function toSentenceCase(value: string): string {
  let current = value.slice();
  let buffer = '';
  while (CHAR_TEST_REGEXP.test(current)) {
    const charIndex = current.search(CHAR_TEST_REGEXP);
    current =
      current.slice(0, charIndex) + current[charIndex].toLocaleUpperCase() + current.slice(charIndex + 1).toLocaleLowerCase();
    const puncIndex = current.search(PUNC_TEST_REGEXP);
    if (puncIndex === -1) {
      buffer += current;
      break;
    }
    buffer += current.slice(0, puncIndex + 1);
    current = current.slice(puncIndex + 1);
  }
  return buffer;
}

function toSnakeCase(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[ -]/g, '_')
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '');
}

function extractEmail(value: string): string | undefined {
  const m = EMAIL_REGEXP.exec(value);
  return m ? m[0] : undefined;
}

function extractDomain(value: string): string | undefined {
  if (isEmail(value)) {
    const m = EMAIL_REGEXP.exec(value);
    return m ? m.groups?.domain : undefined;
  }
  const d = value.match(DOMAIN_EXTRACT_REGEXP);
  return d ? d[1] : undefined;
}

function extractUrl(value: string): string | undefined {
  const m = URL_REGEXP.exec(value);
  return m ? m[0] : undefined;
}

function extractUrlPath(value: string): string | undefined {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    if (value.includes("'")) throw new ExpressionExtensionError("Parsing failed. Check you're using double quotes");
    throw new ExpressionExtensionError('Parsing failed');
  }
}

function toBoolean(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.length > 0 && !new Set(['false', 'no', '0']).has(normalized);
}

const fns: Record<string, (value: string, args: unknown[]) => unknown> = {
  hash,
  removeMarkdown,
  removeTags: (v) => v.replace(/<[^>]*>?/gm, ''),
  toDate,
  toDateTime: stringToDateTime,
  toBoolean,
  toDecimalNumber: toFloat,
  toNumber,
  toFloat,
  toInt,
  toWholeNumber: toInt,
  toSentenceCase,
  toSnakeCase,
  toTitleCase: (v) => titleCase(v),
  urlDecode,
  urlEncode,
  quote,
  replaceSpecialChars: (v) => transliterate(v, { unknown: '?' }),
  length: (v) => v.length,
  isDomain: (v) => DOMAIN_REGEXP.test(v),
  isEmail,
  isNumeric,
  isUrl: (v) => URL_REGEXP_EXACT.test(v),
  isEmpty: (v) => v === '',
  isNotEmpty: (v) => v !== '',
  toJsonString: (v) => JSON.stringify(v),
  extractEmail,
  extractDomain,
  extractUrl,
  extractUrlPath,
  parseJson,
  base64Encode: (v) => toBase64(v),
  base64Decode: (v) => fromBase64(v),
};

export const stringExtensions: ExtensionMap = {
  typeName: 'String',
  functions: fns as unknown as Record<string, ExtensionFunction>,
};

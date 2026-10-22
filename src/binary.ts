// Binary data. Small files (<= 1 MB) are stored as base64 in the item, larger ones in the file store.
// Field names and formats as in n8n 1.123.0:
//   packages/core/src/execution-engine/node-execution-context/utils/binary-helper-functions.ts
//   packages/core/src/binary-data/binary-data.service.ts (fileSize via pretty-bytes)
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, parse as parsePath } from 'node:path';
import { tmpdir } from 'node:os';
import type { BinaryRef } from './types.js';

export const INLINE_LIMIT = 1024 * 1024;
const STORE_PREFIX = 'filuflow-fs:';
/** Prefix before the rename to filuflow; older executions still reference it */
const LEGACY_STORE_PREFIX = 'flowlite-fs:';

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain', text: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'application/javascript', mjs: 'application/javascript', json: 'application/json',
  xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  eml: 'message/rfc822', md: 'text/markdown', yaml: 'text/yaml', yml: 'text/yaml',
};

const EXT_BY_MIME: Record<string, string> = {
  'text/plain': 'txt', 'text/csv': 'csv', 'text/html': 'html', 'text/css': 'css', 'application/javascript': 'js',
  'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml', 'application/pdf': 'pdf',
  'application/zip': 'zip', 'application/gzip': 'gz', 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'audio/mpeg': 'mpga', 'audio/wav': 'wav', 'video/mp4': 'mp4',
  'message/rfc822': 'eml', 'text/markdown': 'md', 'application/octet-stream': 'bin',
};

export function lookupMimeType(fileName: string): string | undefined {
  const ext = parsePath(fileName).ext.slice(1).toLowerCase();
  return MIME_BY_EXT[ext];
}

export function extensionForMime(mimeType: string): string | undefined {
  return EXT_BY_MIME[mimeType.split(';')[0].trim().toLowerCase()];
}

/** n8n fileTypeFromMimeType */
export function fileTypeFromMimeType(mimeType: string): string | undefined {
  if (mimeType.startsWith('application/json')) return 'json';
  if (mimeType.startsWith('text/html')) return 'html';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('text/') || mimeType.startsWith('application/javascript')) return 'text';
  if (mimeType.startsWith('application/pdf')) return 'pdf';
  return undefined;
}

/** Behaves like the npm package pretty-bytes (base 1000, three significant digits) */
export function prettyBytes(size: number): string {
  if (size < 1) return `${size} B`;
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log10(size) / 3), units.length - 1);
  const value = Number((size / 1000 ** exponent).toPrecision(3));
  return `${value.toLocaleString('en-US')} ${units[exponent]}`;
}

export interface PrepareOptions {
  /**
   * Like n8n copyBinaryFile (webhook uploads): keep the file name unchanged,
   * extension only from the MIME type, no directory
   */
  copy?: boolean;
}

export interface BinaryStore {
  prepare(data: Buffer, fileName?: string, mimeType?: string, options?: PrepareOptions): Promise<BinaryRef>;
  getBuffer(ref: BinaryRef): Promise<Buffer>;
  /** For logs and the execution store: large data is only referenced */
  cleanup?(): Promise<void>;
}

export class FileBinaryStore implements BinaryStore {
  private readonly dir: string;
  private readonly inlineLimit: number;

  constructor(dir = process.env.FILUFLOW_BINARY_DIR ?? join(tmpdir(), 'filuflow-binary'), inlineLimit = INLINE_LIMIT) {
    this.dir = dir;
    this.inlineLimit = inlineLimit;
  }

  async prepare(data: Buffer, fileName?: string, mimeType?: string, options: PrepareOptions = {}): Promise<BinaryRef> {
    let fileExtension: string | undefined;
    if (!mimeType && fileName) mimeType = lookupMimeType(fileName);
    if (!fileExtension && mimeType) fileExtension = extensionForMime(mimeType);
    if (!mimeType) mimeType = 'text/plain';
    const ref: BinaryRef = { mimeType };
    const fileType = fileTypeFromMimeType(mimeType);
    if (fileType) ref.fileType = fileType;
    if (fileExtension) ref.fileExtension = fileExtension;
    ref.data = '';
    if (fileName && options.copy) {
      ref.fileName = fileName;
    } else if (fileName) {
      const parts = parsePath(fileName);
      if (parts.dir !== '') ref.directory = parts.dir;
      ref.fileName = parts.base;
      const ext = parts.ext.slice(1);
      if (ext) ref.fileExtension = ext;
    }
    if (data.length <= this.inlineLimit) {
      ref.data = data.toString('base64');
      ref.fileSize = prettyBytes(data.length);
      return ref;
    }
    await mkdir(this.dir, { recursive: true });
    const id = randomUUID();
    await writeFile(join(this.dir, id), data);
    ref.id = `${STORE_PREFIX}${id}`;
    ref.data = 'filesystem';
    ref.fileSize = prettyBytes(data.length);
    return ref;
  }

  /** ID of the file in the store (also with the old prefix), otherwise undefined */
  private storeId(ref: BinaryRef): string | undefined {
    for (const prefix of [STORE_PREFIX, LEGACY_STORE_PREFIX]) if (ref.id?.startsWith(prefix)) return ref.id.slice(prefix.length);
    return undefined;
  }

  async getBuffer(ref: BinaryRef): Promise<Buffer> {
    const id = this.storeId(ref);
    if (id !== undefined) {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Invalid binary ID ${ref.id}`);
      return readFile(join(this.dir, id));
    }
    return Buffer.from(ref.data ?? '', 'base64');
  }

  async remove(ref: BinaryRef): Promise<void> {
    const id = this.storeId(ref);
    if (id !== undefined && /^[0-9a-f-]{36}$/.test(id)) await rm(join(this.dir, id), { force: true });
  }
}

#!/usr/bin/env node
// Startet die gebaute CLI; im Entwicklungsmodus (ohne dist) über tsx.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'cli', 'main.js');
if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import(pathToFileURL(join(root, 'src', 'cli', 'main.ts')).href);
}

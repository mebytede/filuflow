#!/usr/bin/env node
// Starts the built CLI; in development mode (without dist) via tsx.
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

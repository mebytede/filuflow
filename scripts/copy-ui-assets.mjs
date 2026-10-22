// Copies the static files of the web interface (HTML, CSS, icons) to dist/ui.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'ui', 'static');
const out = join(root, 'dist', 'ui');
mkdirSync(out, { recursive: true });
for (const file of readdirSync(src)) cpSync(join(src, file), join(out, file), { recursive: true });

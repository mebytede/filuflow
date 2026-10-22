// Builds the web interface once before all tests (the browser tests need dist/ui). Previously both browser tests
// built in parallel and got in each other's way while copying the files. The golden tests do not need it.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Only golden tests selected? Values of --exclude do not count (npm test excludes test/compat with it). */
function onlyCompat(argv: string[]): boolean {
  const filters: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exclude') {
      i++;
      continue;
    }
    if (a.startsWith('-') || a === 'run' || a === 'watch') continue;
    filters.push(a);
  }
  return filters.length > 0 && filters.every((f) => f.includes('test/compat'));
}

export default function setup(): void {
  if (onlyCompat(process.argv.slice(2))) return;
  const root = join(import.meta.dirname, '..', '..');
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.ui.json')], { cwd: root });
  execFileSync(process.execPath, [join(root, 'scripts', 'copy-ui-assets.mjs')], { cwd: root });
}

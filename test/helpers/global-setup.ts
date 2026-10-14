// Baut die Weboberfläche einmal vor allen Tests (die Browser-Tests brauchen dist/ui). Vorher bauten beide
// Browser-Tests parallel und kamen sich beim Kopieren der Dateien in die Quere. Die Golden-Tests brauchen sie nicht.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default function setup(): void {
  if (process.argv.some((a) => a.includes('test/compat'))) return;
  const root = join(import.meta.dirname, '..', '..');
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.ui.json')], { cwd: root });
  execFileSync(process.execPath, [join(root, 'scripts', 'copy-ui-assets.mjs')], { cwd: root });
}

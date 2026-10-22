// Baut die Weboberfläche einmal vor allen Tests (die Browser-Tests brauchen dist/ui). Vorher bauten beide
// Browser-Tests parallel und kamen sich beim Kopieren der Dateien in die Quere. Die Golden-Tests brauchen sie nicht.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Nur Golden-Tests ausgewählt? Werte von --exclude zählen nicht (npm test schließt test/compat damit aus). */
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

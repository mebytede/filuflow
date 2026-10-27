#!/usr/bin/env node
// Prints the body of one version's section from CHANGELOG.md (Keep a Changelog format), used as the GitHub release notes.
//
// Usage: node scripts/changelog-section.mjs <version> [--require-date]
//   <version>        e.g. 0.1.0 (a leading "v" is ignored)
//   --require-date   fail unless the heading carries a release date: "## [0.1.0] - 2026-11-02"
// Exits with 1 if the section is missing or empty.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'))?.replace(/^v/, '');
const requireDate = args.includes('--require-date');
if (!version) {
  process.stderr.write('usage: node scripts/changelog-section.mjs <version> [--require-date]\n');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## \\[${escaped}\\](\\s|$)`);
const start = lines.findIndex((l) => heading.test(l));
if (start < 0) {
  process.stderr.write(`CHANGELOG.md has no section "## [${version}]"\n`);
  process.exit(1);
}
if (requireDate && !/ - \d{4}-\d{2}-\d{2}\s*$/.test(lines[start])) {
  process.stderr.write(`CHANGELOG.md: the heading "${lines[start]}" has no release date (expected "## [${version}] - YYYY-MM-DD")\n`);
  process.exit(1);
}
// The section ends at the next version heading or at the link reference definitions at the end of the file
let end = lines.findIndex((l, i) => i > start && (/^## /.test(l) || /^\[[^\]]+\]: /.test(l)));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  process.stderr.write(`CHANGELOG.md: the section "## [${version}]" is empty\n`);
  process.exit(1);
}
process.stdout.write(body + '\n');

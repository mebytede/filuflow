// flowlite validate <wf.json> [--json] [--credentials <pfad>]
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { validateWorkflow, formatIssues } from '../validator.js';
import { getDefaultRegistry } from '../nodes/index.js';
import { loadDefaultCredentials } from '../credentials/store.js';
import type { ValidationIssue } from '../errors.js';

export async function cmdValidate(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      credentials: { type: 'string' },
      'no-credentials': { type: 'boolean', default: false },
    },
  });
  const file = positionals[0];
  if (!file) {
    process.stderr.write('Aufruf: flowlite validate <wf.json> [--json]\n');
    return 1;
  }
  let issues: ValidationIssue[];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(raw) && raw.length === 1) raw = raw[0];
  } catch (error) {
    issues = [{ severity: 'error', code: 'json.parse', message: `${file}: ${(error as Error).message}` }];
    return report(issues, values.json);
  }
  const credentials = values['no-credentials'] ? undefined : await loadDefaultCredentials(values.credentials);
  const result = validateWorkflow(raw, {
    registry: getDefaultRegistry(),
    credentials,
    checkCredentials: !values['no-credentials'],
  });
  return report(result.issues, values.json);
}

function report(issues: ValidationIssue[], json: boolean | undefined): number {
  const valid = !issues.some((i) => i.severity === 'error');
  if (json) {
    process.stdout.write(`${JSON.stringify({ valid, issues }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatIssues(issues)}\n`);
    process.stdout.write(valid ? 'Workflow ist gültig.\n' : 'Workflow ist ungültig.\n');
  }
  return valid ? 0 : 1;
}

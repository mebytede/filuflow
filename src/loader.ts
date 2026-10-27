// Loads workflow JSON files (exported workflows) from disk.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workflow } from './types.js';
import { WorkflowValidationError } from './errors.js';

export interface LoadedWorkflow {
  workflow: Workflow;
  file?: string;
}

/**
 * Accepts a workflow object or an array with exactly one workflow
 * (this is how the reference CLI command `export:workflow` exports with `--all` or in some versions).
 */
export function parseWorkflow(raw: unknown, source = 'input'): Workflow {
  let value = raw;
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new WorkflowValidationError(`${source}: expected exactly one workflow, found ${value.length}`, [
        { severity: 'error', code: 'json.structure', message: `Array with ${value.length} workflows` },
      ]);
    }
    value = value[0];
  }
  if (value === null || typeof value !== 'object') {
    throw new WorkflowValidationError(`${source}: not a workflow object`, [
      { severity: 'error', code: 'json.structure', message: 'Root is not an object' },
    ]);
  }
  return value as Workflow;
}

export async function loadWorkflowFile(file: string): Promise<Workflow> {
  const text = await readFile(file, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new WorkflowValidationError(`${file}: invalid JSON`, [
      { severity: 'error', code: 'json.parse', message: (error as Error).message },
    ]);
  }
  return parseWorkflow(raw, file);
}

/** Loads all *.json files of a directory. Invalid files are reported with an error. */
export async function loadWorkflowDir(
  dir: string,
): Promise<Array<{ file: string; workflow?: Workflow; error?: Error }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: Array<{ file: string; workflow?: Workflow; error?: Error }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(dir, entry.name);
    try {
      out.push({ file, workflow: await loadWorkflowFile(file) });
    } catch (error) {
      out.push({ file, error: error as Error });
    }
  }
  return out;
}

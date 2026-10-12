// Lädt Workflow-JSONs (n8n-Export) von der Platte.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workflow } from './types.js';
import { WorkflowValidationError } from './errors.js';

export interface LoadedWorkflow {
  workflow: Workflow;
  file?: string;
}

/**
 * Akzeptiert ein Workflow-Objekt oder ein Array mit genau einem Workflow
 * (so exportiert `n8n export:workflow` bei `--all` bzw. manchen Versionen).
 */
export function parseWorkflow(raw: unknown, source = 'Eingabe'): Workflow {
  let value = raw;
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new WorkflowValidationError(`${source}: erwartet genau einen Workflow, gefunden ${value.length}`, [
        { severity: 'error', code: 'json.structure', message: `Array mit ${value.length} Workflows` },
      ]);
    }
    value = value[0];
  }
  if (value === null || typeof value !== 'object') {
    throw new WorkflowValidationError(`${source}: kein Workflow-Objekt`, [
      { severity: 'error', code: 'json.structure', message: 'Wurzel ist kein Objekt' },
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
    throw new WorkflowValidationError(`${file}: ungültiges JSON`, [
      { severity: 'error', code: 'json.parse', message: (error as Error).message },
    ]);
  }
  return parseWorkflow(raw, file);
}

/** Lädt alle *.json eines Verzeichnisses. Fehlerhafte Dateien werden mit Fehler gemeldet. */
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

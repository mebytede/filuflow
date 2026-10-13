// Lesen lokaler Dateien aus Knoten (Execute Workflow "Local File").
// n8n liest dort ohne Einschränkung (ExecuteWorkflow/GenericFunctions.ts nutzt fs.readFile direkt); filuflow erlaubt
// zusätzlich, das Lesen auf Verzeichnisse zu begrenzen: FILUFLOW_RESTRICT_FILE_ACCESS_TO (wie n8n
// N8N_RESTRICT_FILE_ACCESS_TO, mehrere Verzeichnisse mit ";" getrennt). Relative Pfade gelten ab dem Arbeitsverzeichnis.
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export function allowedDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.FILUFLOW_RESTRICT_FILE_ACCESS_TO ?? env.N8N_RESTRICT_FILE_ACCESS_TO ?? '';
  return raw
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => resolve(d));
}

/** Liefert den aufgelösten Pfad oder wirft, wenn er außerhalb der erlaubten Verzeichnisse liegt */
export async function checkFileAccess(path: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const absolute = resolve(path);
  const dirs = allowedDirectories(env);
  if (!dirs.length) return absolute;
  // Symlinks auflösen, damit kein Link aus dem erlaubten Verzeichnis herausführt
  let real = absolute;
  try {
    real = await realpath(absolute);
  } catch {
    // Datei fehlt: der Aufrufer meldet das beim Lesen
  }
  const realDirs = await Promise.all(dirs.map((d) => realpath(d).catch(() => d)));
  if (!realDirs.some((d) => real === d || real.startsWith(d.endsWith(sep) ? d : d + sep))) {
    throw new Error(`Zugriff auf "${path}" ist nicht erlaubt (FILUFLOW_RESTRICT_FILE_ACCESS_TO: ${dirs.join(';')})`);
  }
  return absolute;
}

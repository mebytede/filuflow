// Reading local files from nodes (Execute Workflow "Local File").
// n8n reads there without restriction (ExecuteWorkflow/GenericFunctions.ts uses fs.readFile directly); filuflow also
// allows limiting reads to directories: FILUFLOW_RESTRICT_FILE_ACCESS_TO (like n8n
// N8N_RESTRICT_FILE_ACCESS_TO, several directories separated by ";"). Relative paths are resolved from the working directory.
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

/** Returns the resolved path or throws if it lies outside the allowed directories */
export async function checkFileAccess(path: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const absolute = resolve(path);
  const dirs = allowedDirectories(env);
  if (!dirs.length) return absolute;
  // Resolve symlinks so no link leads out of the allowed directory
  let real = absolute;
  try {
    real = await realpath(absolute);
  } catch {
    // File missing: the caller reports that when reading
  }
  const realDirs = await Promise.all(dirs.map((d) => realpath(d).catch(() => d)));
  if (!realDirs.some((d) => real === d || real.startsWith(d.endsWith(sep) ? d : d + sep))) {
    throw new Error(`Access to "${path}" is not allowed (FILUFLOW_RESTRICT_FILE_ACCESS_TO: ${dirs.join(';')})`);
  }
  return absolute;
}

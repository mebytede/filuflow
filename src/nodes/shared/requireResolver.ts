// require im Code-Node mit Freigabelisten, nachgebaut nach n8n 1.123.0
// packages/@n8n/task-runner/src/js-task-runner/require-resolver.ts und js-task-runner.ts (parseModuleAllowList):
//   NODE_FUNCTION_ALLOW_BUILTIN / NODE_FUNCTION_ALLOW_EXTERNAL: Modulnamen mit Komma getrennt oder "*"
//   (filuflow liest zuerst FILUFLOW_FUNCTION_ALLOW_BUILTIN / FILUFLOW_FUNCTION_ALLOW_EXTERNAL).
// Ohne Freigabe ist jedes Modul gesperrt: "Module 'x' is disallowed". Externe Module werden aus der Installation von
// filuflow geladen (node_modules neben dem Paket), wie bei n8n aus der des Task-Runners.
import { createRequire, isBuiltin } from 'node:module';

export type AllowList = Set<string> | '*';

export function parseModuleAllowList(list: string): AllowList {
  if (list.trim() === '*') return '*';
  return new Set(
    list
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== ''),
  );
}

export class DisallowedModuleError extends Error {
  constructor(moduleName: string) {
    super(`Module '${moduleName}' is disallowed`);
    this.name = 'DisallowedModuleError';
  }
}

export interface RequireOptions {
  builtin: AllowList;
  external: AllowList;
}

export function requireOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RequireOptions {
  return {
    builtin: parseModuleAllowList(env.FILUFLOW_FUNCTION_ALLOW_BUILTIN ?? env.NODE_FUNCTION_ALLOW_BUILTIN ?? ''),
    external: parseModuleAllowList(env.FILUFLOW_FUNCTION_ALLOW_EXTERNAL ?? env.NODE_FUNCTION_ALLOW_EXTERNAL ?? ''),
  };
}

const nodeRequire = createRequire(import.meta.url);

export function createRequireResolver(options: RequireOptions = requireOptionsFromEnv()): (request: string) => unknown {
  const allowed = (list: AllowList, name: string) => list === '*' || list.has(name);
  return (request: string) => {
    const ok = isBuiltin(request) ? allowed(options.builtin, request) : allowed(options.external, request);
    if (!ok) throw new DisallowedModuleError(request);
    return nodeRequire(request) as unknown;
  };
}

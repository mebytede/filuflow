// require in the Code node with allow lists, rebuilt after n8n 1.123.0
// packages/@n8n/task-runner/src/js-task-runner/require-resolver.ts and js-task-runner.ts (parseModuleAllowList):
//   NODE_FUNCTION_ALLOW_BUILTIN / NODE_FUNCTION_ALLOW_EXTERNAL: module names separated by commas, or "*"
//   (filuflow reads FILUFLOW_FUNCTION_ALLOW_BUILTIN / FILUFLOW_FUNCTION_ALLOW_EXTERNAL first).
// Without an allow entry every module is blocked: "Module 'x' is disallowed". External modules are loaded from the
// filuflow installation (node_modules next to the package), as n8n loads them from the task runner's.
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

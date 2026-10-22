// Transition from flowlite to filuflow: old environment variables (FLOWLITE_*) still apply if the new one
// (FILUFLOW_*) is not set. Loaded as the first module of the CLI so that all other modules already see the
// new names. The CLI reports the list of taken-over names as a warning at startup.
export const legacyEnvNames: string[] = applyLegacyEnv(process.env);

export function applyLegacyEnv(env: NodeJS.ProcessEnv): string[] {
  const used: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('FLOWLITE_') || value === undefined) continue;
    const next = `FILUFLOW_${key.slice('FLOWLITE_'.length)}`;
    if (env[next] === undefined) {
      env[next] = value;
      used.push(key);
    }
  }
  return used.sort();
}

// Übergang von flowlite zu filuflow: alte Umgebungsvariablen (FLOWLITE_*) gelten weiter, wenn die neue
// (FILUFLOW_*) nicht gesetzt ist. Wird als erstes Modul der CLI geladen, damit alle anderen Module die
// neuen Namen schon sehen. Die Liste der übernommenen Namen meldet die CLI beim Start als Warnung.
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

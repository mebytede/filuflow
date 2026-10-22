// Shared conversion of n8n resultData into the comparison format (like src/snapshot.ts).
export function cleanItem(item) {
  const out = { json: item.json };
  if (item.binary) {
    out.binary = {};
    for (const [k, v] of Object.entries(item.binary)) {
      const { data, id: _id, ...rest } = v;
      out.binary[k] = { ...rest, ...(data && data !== 'filesystem' && data !== 'filesystem-v2' ? { data } : {}) };
    }
  }
  if (item.pairedItem !== undefined) out.pairedItem = item.pairedItem;
  if (item.error !== undefined) out.error = { message: item.error.message };
  return out;
}

export function resultDataToSnapshot(resultData) {
  const runData = resultData.runData ?? {};
  const nodes = {};
  for (const [name, runs] of Object.entries(runData)) {
    nodes[name] = runs.map((run) => {
      const r = {
        status: run.executionStatus,
        source: run.source ?? [],
        main: (run.data?.main ?? []).map((output) => (output === null ? null : output.map(cleanItem))),
      };
      if (run.error) r.error = run.error.message;
      return r;
    });
  }
  return {
    status: resultData.error ? 'error' : 'success',
    lastNodeExecuted: resultData.lastNodeExecuted,
    ...(resultData.error ? { error: resultData.error.message } : {}),
    // Execution order (executionIndex)
    order: Object.entries(runData)
      .flatMap(([name, runs]) => runs.map((r) => ({ name, i: r.executionIndex })))
      .sort((a, b) => a.i - b.i)
      .map((e) => e.name),
    nodes,
  };
}

/** Own implementation of the flatted format (n8n stores execution data this way) */
export function flattedParse(text) {
  const input = JSON.parse(text, (_k, v) => (typeof v === 'string' ? new String(v) : v)).map((v) => (v instanceof String ? String(v) : v));
  const revive = (output, parsed) => {
    for (const k of Object.keys(output)) {
      const value = output[k];
      if (value instanceof String) {
        const target = input[Number(value)];
        if (target !== null && typeof target === 'object' && !parsed.has(target)) {
          parsed.add(target);
          output[k] = revive(target, parsed);
        } else {
          output[k] = target;
        }
      }
    }
    return output;
  };
  const root = input[0];
  return root !== null && typeof root === 'object' ? revive(root, new Set([root])) : root;
}

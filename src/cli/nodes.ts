// flowlite nodes [--json]: unterstützte Node-Typen und Versionen
import { parseArgs } from 'node:util';
import { getDefaultRegistry } from '../nodes/index.js';

export async function cmdNodes(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } });
  const list = getDefaultRegistry()
    .list()
    .map((t) => ({ type: t.type, displayName: t.displayName, versions: t.versions, trigger: !!t.isTrigger }));
  if (values.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  const width = Math.max(...list.map((l) => l.type.length), 10);
  for (const l of list) {
    process.stdout.write(`${l.type.padEnd(width)}  v${l.versions.join(', v')}${l.trigger ? '  (Trigger)' : ''}\n`);
  }
  return 0;
}

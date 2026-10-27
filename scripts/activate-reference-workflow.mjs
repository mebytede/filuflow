#!/usr/bin/env node
// Activates an imported workflow directly in the SQLite database of the reference implementation.
// In the reference version 1.123, `update:workflow --active=true` fails after `import:workflow` because the import does not create
// an entry in workflow_history (foreign key activeVersionId). Only used for recording.
// Usage: node scripts/activate-reference-workflow.mjs <database.sqlite> <workflow-id>
import Database from 'better-sqlite3';

const [, , dbFile, id] = process.argv;
const db = new Database(dbFile);
const wf = db.prepare('SELECT id, name, nodes, connections, versionId FROM workflow_entity WHERE id = ?').get(id);
if (!wf) throw new Error(`Workflow ${id} not found`);
db.prepare(
  `INSERT OR REPLACE INTO workflow_history (versionId, workflowId, authors, nodes, connections, name) VALUES (?, ?, 'filuflow', ?, ?, ?)`,
).run(wf.versionId, wf.id, wf.nodes, wf.connections, wf.name);
db.prepare('UPDATE workflow_entity SET active = 1, activeVersionId = versionId WHERE id = ?').run(id);
db.close();
console.log(`activated: ${wf.name}`);

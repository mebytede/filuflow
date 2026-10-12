#!/usr/bin/env node
// Aktiviert einen importierten Workflow direkt in der n8n-SQLite-Datenbank.
// n8n 1.123 `update:workflow --active=true` scheitert nach `import:workflow`, weil der Import keinen
// Eintrag in workflow_history anlegt (Fremdschlüssel activeVersionId). Nur für die Aufzeichnung.
// Aufruf: node scripts/activate-n8n-workflow.mjs <database.sqlite> <workflow-id>
import Database from 'better-sqlite3';

const [, , dbFile, id] = process.argv;
const db = new Database(dbFile);
const wf = db.prepare('SELECT id, name, nodes, connections, versionId FROM workflow_entity WHERE id = ?').get(id);
if (!wf) throw new Error(`Workflow ${id} nicht gefunden`);
db.prepare(
  `INSERT OR REPLACE INTO workflow_history (versionId, workflowId, authors, nodes, connections, name) VALUES (?, ?, 'filuflow', ?, ?, ?)`,
).run(wf.versionId, wf.id, wf.nodes, wf.connections, wf.name);
db.prepare('UPDATE workflow_entity SET active = 1, activeVersionId = versionId WHERE id = ?').run(id);
db.close();
console.log(`aktiviert: ${wf.name}`);

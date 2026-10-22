// German catalog: all areas merged. Keys are the English source texts (see src/ui/i18n.ts).
import { de as app } from './ui-app.js';
import { de as editor } from './ui-editor.js';
import { de as master } from './ui-master.js';
import { de as nodesA } from './params-nodes-a.js';
import { de as nodesB } from './params-nodes-b.js';
import { de as nodesC } from './params-nodes-c.js';
import { de as credentials } from './params-credentials.js';

export const de: Record<string, string> = { ...nodesA, ...nodesB, ...nodesC, ...credentials, ...master, ...editor, ...app };

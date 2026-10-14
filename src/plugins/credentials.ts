// Credential-Typen aus Plugins (M24): Formular in der Oberfläche, Defaults versteckter Felder und Authentifizierung
// von Requests über src/credentials/authenticate.ts (n8n ICredentialType.authenticate, generisch oder als Funktion).
import { registerCredentialType } from '../credentials/types.js';
import { registerCredentialAuth, type AuthDefinition } from '../credentials/authenticate.js';
import { credentialToSchema, type N8nCredentialType } from './n8nDescription.js';

export function registerPluginCredential(c: N8nCredentialType): void {
  registerCredentialType(credentialToSchema(c));
  const defaults = Object.fromEntries((c.properties ?? []).filter((p) => p.default !== undefined).map((p) => [p.name, p.default]));
  const auth = c.authenticate as AuthDefinition['authenticate'] | undefined;
  if (auth && (typeof auth === 'function' || (typeof auth === 'object' && (auth as { type?: string }).type === 'generic'))) {
    registerCredentialAuth(c.name, { authenticate: typeof auth === 'function' ? auth.bind(c) : auth, defaults });
  } else {
    // Ohne Authentifizierung trotzdem die Defaults bekannt machen (z. B. für getCredentials im Knoten)
    registerCredentialAuth(c.name, { authenticate: (_c, o) => o, defaults, passive: true });
  }
}

// Credential types from plugins (M24): form in the web interface, defaults of hidden fields and authentication
// of requests via src/credentials/authenticate.ts (n8n ICredentialType.authenticate, generic or as a function).
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
    // Without authentication, still register the defaults (e.g. for getCredentials in the node)
    registerCredentialAuth(c.name, { authenticate: (_c, o) => o, defaults, passive: true });
  }
}

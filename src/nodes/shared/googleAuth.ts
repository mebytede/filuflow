// Authorized requests to Google APIs, shared by the Gmail (M40) and Google Sheets (M52) nodes: OAuth2 with the node's
// credential type (token renewed once after 401 like requestOAuth2) or a service account (googleApi, JWT bearer flow
// with the scopes of getGoogleAccessToken; with "Set up for use in HTTP Request node" the credential's own token wins).
// Reference: n8n-nodes-base 1.121.0, nodes/Google/GenericFunctions.js (getGoogleAccessToken) and the transports of
// nodes/Google/Gmail/GenericFunctions.js and nodes/Google/Sheet/v2/transport/index.js.
import type { ExecContext } from '../types.js';
import type { HttpResponse } from '../../http.js';
import { NodeApiError } from '../../errors.js';
import { getOAuth2Token, oauth2ServiceOptions } from '../../credentials/oauth2.js';
import { authenticateRequest, withCredentialDefaults } from '../../credentials/authenticate.js';
import { GoogleTokenError, getGoogleAccessToken } from '../../credentials/googleServiceAccount.js';

/** Description of a Google error response ({ error: { message } }, { error_description }) */
export function googleErrorDescription(body: unknown): string | undefined {
  if (typeof body === 'string') return body || undefined;
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { error?: unknown; error_description?: unknown; message?: unknown };
  if (b.error && typeof b.error === 'object' && typeof (b.error as Record<string, unknown>).message === 'string') return (b.error as Record<string, unknown>).message as string;
  if (typeof b.error_description === 'string') return b.error_description;
  if (typeof b.message === 'string') return b.message;
  if (typeof b.error === 'string') return b.error;
  return undefined;
}

export interface GoogleRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** OAuth2 credential type of the node (e.g. gmailOAuth2, googleSheetsOAuth2Api) */
  oauthType: string;
  /** Scopes of the service account (GOOGLE_SERVICE_ACCOUNT_SCOPES entry) */
  scopes: string[];
  serviceAccount: boolean;
}

/** Send the request with the node's Google authentication */
export async function googleAuthorizedRequest(ctx: ExecContext, r: GoogleRequest): Promise<HttpResponse> {
  const send = (authorization: string) => ctx.helpers.http.request({ method: r.method, url: r.url, headers: { ...r.headers, authorization }, body: r.body, signal: ctx.signal, timeout: 300_000 });
  if (r.serviceAccount) {
    const credentials = await ctx.getCredentials('googleApi');
    let token: string;
    try {
      token = await getGoogleAccessToken(ctx.helpers.http, credentials, r.scopes, { signal: ctx.signal });
    } catch (error) {
      if (error instanceof GoogleTokenError) {
        throw new NodeApiError(ctx.node.name, error.message, { httpCode: String(error.statusCode), description: googleErrorDescription(error.body) ?? null });
      }
      throw error;
    }
    let authorization = `Bearer ${token}`;
    if (credentials.httpNode === true) {
      const authed = await authenticateRequest('googleApi', credentials, { url: r.url, headers: { authorization } }, { http: ctx.helpers.http, signal: ctx.signal });
      authorization = String((authed.headers as Record<string, unknown> | undefined)?.Authorization ?? authorization);
    }
    return send(authorization);
  }
  const credentials = withCredentialDefaults(r.oauthType, await ctx.getCredentials(r.oauthType));
  const options = oauth2ServiceOptions(r.oauthType);
  const token = await getOAuth2Token(ctx, credentials, false, options);
  const res = await send(`Bearer ${token.accessToken}`);
  if (res.statusCode !== 401) return res;
  const fresh = await getOAuth2Token(ctx, credentials, true, options);
  return send(`Bearer ${fresh.accessToken}`);
}

/** Parsed JSON body, the text when it is no JSON, undefined when empty */
export function parseGoogleBody(res: HttpResponse): unknown {
  const text = res.body.toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

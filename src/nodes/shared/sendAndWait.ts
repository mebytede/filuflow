// "Send and Wait for Response" (Gmail operation sendAndWait, M40). Behavior as in n8n-nodes-base 1.121.0
// utils/sendAndWait/utils.js (getSendAndWaitConfig, createEmail, sendAndWaitWebhook), configureWaitTillDate.util.js,
// n8n-core 1.122.0 node-execution-context.js getSignedResumeUrl with utils/signature-helpers.js (HMAC-SHA256 over
// host, path and query, query parameter "signature") and the reference version 1.123.0, webhooks/waiting-webhooks.ts (signature check,
// page "no action required" for finished executions).
// The node sends the email and waits; $execution.resumeUrl/<node ID>?approved=true|false&signature=... resumes it with
// { data: { approved } }, a form ("Free Text", "Custom Form") with { data: { text } } or { data: { <fields> } }.
// Differences: the email and the pages use filuflow's own HTML (the reference's templates are not copied, the texts are the same);
// the parameters the pages need are resolved when the email is sent and kept in the node context of the waiting
// execution (the reference evaluates them again in the webhook).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ExecContext } from '../types.js';
import type { Item } from '../../types.js';
import type { BinaryStore } from '../../binary.js';
import { NodeOperationError } from '../../errors.js';
import { WAIT_INDEFINITELY } from '../../engine/executor.js';
import { formFieldsOf, formReturnItem, renderCompletionPage, renderFormPage, type FormField } from './form.js';
import type { Email } from './gmail.js';

export const SEND_AND_WAIT_OPERATION = 'sendAndWait';
/** Key in the node context of the waiting execution */
export const SEND_AND_WAIT_CONTEXT_KEY = 'sendAndWait';

// ---------------------------------------------------------------------------------------------------------------
// Signed resume URLs
// ---------------------------------------------------------------------------------------------------------------

let secret: string | undefined;

/** Secret for the URL signatures: FILUFLOW_HMAC_SIGNATURE_SECRET, set by the server or random */
export function signatureSecret(): string {
  const fromEnv = process.env.FILUFLOW_HMAC_SIGNATURE_SECRET;
  if (fromEnv) return fromEnv;
  secret ??= randomBytes(32).toString('hex');
  return secret;
}

/** The server keeps the secret in its database so that links stay valid after a restart */
export function setSignatureSecret(value: string | undefined): void {
  secret = value;
}

const sign = (url: URL) => createHmac('sha256', signatureSecret()).update(`${url.host}${url.pathname}${url.search}`).digest('hex');

/** getSignedResumeUrl: <resumeUrl>/<node ID>?<parameters>&signature=<HMAC> */
export function signedResumeUrl(resumeUrl: string, nodeId: string, parameters: Record<string, string>): string {
  const url = new URL(`${resumeUrl}/${nodeId}`);
  for (const [k, v] of Object.entries(parameters)) url.searchParams.set(k, v);
  url.searchParams.set('signature', sign(url));
  return url.toString();
}

/** validateSignatureInRequest: URL of the request (base of the resume URLs, path, query without "signature") */
export function verifyResumeSignature(baseUrl: string, path: string, query: Record<string, unknown>): boolean {
  const actual = query.signature;
  if (typeof actual !== 'string') return false;
  try {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (k === 'signature') continue;
      for (const value of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(value));
    }
    const expected = sign(url);
    return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Email and wait time
// ---------------------------------------------------------------------------------------------------------------

/** Reference: utilities escapeHtml (despite its name it turns the entities &amp; &lt; &gt; &#39; &quot; back into characters) */
function unescapeEntities(text: string): string {
  const map: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&quot;': '"' };
  return text ? text.replace(/&amp;|&lt;|&gt;|&#39;|&quot;/g, (m) => map[m]) : '';
}

const BUTTON_PRIMARY =
  'display:inline-block; text-decoration:none; background-color:#3b5bdb; color:#ffffff; padding:12px 24px; font-family:Arial,sans-serif; font-size:14px; font-weight:600; border-radius:6px; min-width:120px; margin:12px 4px 0 4px;';
const BUTTON_SECONDARY =
  'display:inline-block; text-decoration:none; background-color:#ffffff; color:#3d3d3d; padding:12px 24px; font-family:Arial,sans-serif; font-size:14px; font-weight:600; border:1px solid #cfd3da; border-radius:6px; min-width:120px; margin:12px 4px 0 4px;';

/** createButton */
function button(url: string, label: string, style: string): string {
  return `<a href="${url}" target="_blank" style="${style === 'secondary' ? BUTTON_SECONDARY : BUTTON_PRIMARY}">${label}</a>`;
}

function emailBody(title: string, message: string, buttons: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
</head>
<body style="font-family: Arial, sans-serif; font-size: 14px; background-color: #f6f7f9; margin: 0; padding: 24px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center">
<table role="presentation" width="448" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 448px; background-color: #ffffff; border: 1px solid #dcdfe6; border-radius: 8px; padding: 24px;">
<tr><td style="text-align: center; color: #3d3d3d;"><p style="white-space: pre-line;">${message}</p></td></tr>
<tr><td align="center" style="padding-top: 12px;">${buttons}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * getSendAndWaitConfig and createEmail: one recipient, subject and message, buttons with signed resume URLs
 * (approve, approve and decline, or "Respond" for the forms). The attribution of the reference is not added (docs/DECISIONS.md).
 */
export function createSendAndWaitEmail(ctx: ExecContext): Email {
  const to = String(ctx.getParam('sendTo', 0, '') ?? '').trim();
  const message = unescapeEntities(String(ctx.getParam('message', 0, '') ?? '').trim())
    .replace(/\\n/g, '\n')
    .replace(/<br>/g, '\n');
  const subject = unescapeEntities(String(ctx.getParam('subject', 0, '') ?? ''));
  const approval = ctx.getParam<Record<string, string>>('approvalOptions.values', 0, {});
  const responseType = ctx.getParam<string>('responseType', 0, 'approval');
  const resumeUrl = String(ctx.evaluateExpression('{{ $execution.resumeUrl }}', 0));
  const nodeId = ctx.node.id;
  const approvedUrl = signedResumeUrl(resumeUrl, nodeId, { approved: 'true' });
  const buttons: string[] = [];
  if (responseType === 'freeText' || responseType === 'customForm') {
    buttons.push(button(approvedUrl, ctx.getParam<string>('options.messageButtonLabel', 0, 'Respond'), 'primary'));
  } else if (approval.approvalType === 'double') {
    buttons.push(button(signedResumeUrl(resumeUrl, nodeId, { approved: 'false' }), unescapeEntities(approval.disapproveLabel || 'Disapprove'), approval.buttonDisapprovalStyle || 'secondary'));
    buttons.push(button(approvedUrl, unescapeEntities(approval.approveLabel || 'Approve'), approval.buttonApprovalStyle || 'primary'));
  } else {
    buttons.push(button(approvedUrl, unescapeEntities(approval.approveLabel || 'Approve'), approval.buttonApprovalStyle || 'primary'));
  }
  if (!to.includes('@') || (to.match(/@/g) ?? []).length > 1) {
    throw new NodeOperationError(ctx.node.name, 'Invalid email address', {
      description: `The email address '${to}' in the 'To' field isn't valid or contains multiple addresses. Please provide only a single email address.`,
      itemIndex: 0,
    });
  }
  return { to, subject, body: '', htmlBody: emailBody(subject, message, buttons.join('\n')) };
}

const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** configureWaitTillDate (location "options"): indefinitely or options.limitWaitTime.values */
export function sendAndWaitTill(ctx: ExecContext): Date {
  const limit = ctx.getParam<Record<string, unknown>>('options.limitWaitTime.values', 0, {});
  if (!Object.keys(limit).length) return WAIT_INDEFINITELY;
  let waitTill: Date;
  if (limit.limitType === 'afterTimeInterval') {
    waitTill = new Date(Date.now() + Number(limit.resumeAmount) * (UNIT_MS[String(limit.resumeUnit)] ?? 1000));
  } else {
    waitTill = new Date(String(limit.maxDateAndTime));
  }
  if (Number.isNaN(waitTill.getTime())) {
    throw new NodeOperationError(ctx.node.name, 'Could not configure Limit Wait Time', { description: 'Invalid date format' });
  }
  return waitTill;
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook (resume)
// ---------------------------------------------------------------------------------------------------------------

/** What the pages need, resolved when the email is sent (getFormResponseCustomizations, form fields) */
export interface SendAndWaitPageConfig {
  responseType: string;
  formTitle: string;
  formDescription: string;
  buttonLabel: string;
  customCss?: string;
  fields: FormField[];
}

export function sendAndWaitPageConfig(ctx: ExecContext): SendAndWaitPageConfig {
  const responseType = ctx.getParam<string>('responseType', 0, 'approval');
  const message = String(ctx.getParam('message', 0, '') ?? '');
  const options = ctx.getParam<Record<string, string>>('options', 0, {});
  let fields: FormField[] = [];
  if (responseType === 'customForm') {
    const defineForm = ctx.getParam<string>('defineForm', 0, 'fields');
    try {
      fields = formFieldsOf({
        defineForm,
        jsonOutput: defineForm === 'json' ? ctx.getParam('jsonOutput', 0, '[]') : undefined,
        formFields: defineForm === 'json' ? undefined : ctx.getParam('formFields', 0, {}),
      });
    } catch (error) {
      throw new NodeOperationError(ctx.node.name, (error as Error).message, { description: (error as Error).message });
    }
  } else if (responseType === 'freeText') {
    fields = [{ fieldLabel: 'Response', fieldType: 'textarea', requiredField: true }];
  }
  return {
    responseType,
    formTitle: options.responseFormTitle || '',
    formDescription: (options.responseFormDescription || message).replace(/\\n/g, '\n').replace(/<br>/g, '\n'),
    buttonLabel: options.responseFormButtonLabel || 'Submit',
    ...(options.responseFormCustomCss ? { customCss: options.responseFormCustomCss } : {}),
    fields,
  };
}

export interface SendAndWaitRequest {
  method: string;
  query: Record<string, unknown>;
  isBot: boolean;
  /** Form data of a POST (lazy, only read when needed) */
  form: () => Promise<FormData>;
  binary: BinaryStore;
  timezone: string;
}

export interface SendAndWaitResult {
  statusCode: number;
  html: string;
  /** Output of the waiting node; without it the execution keeps waiting */
  workflowData?: Item[][];
}

/** ACTION_RECORDED_PAGE */
export const actionRecordedPage = () => renderCompletionPage({ title: 'Got it, thanks', message: 'This page can be closed now' });

/** send-and-wait-no-action-required */
export const noActionRequiredPage = () => renderCompletionPage({ title: 'No action required', message: 'This request has already been answered or is no longer waiting for a response.' });

/** sendAndWaitWebhook */
export async function handleSendAndWaitRequest(config: SendAndWaitPageConfig, request: SendAndWaitRequest): Promise<SendAndWaitResult> {
  const method = request.method.toUpperCase();
  if (config.responseType === 'approval' && request.isBot) return { statusCode: 200, html: '' };
  if (config.responseType === 'freeText' || config.responseType === 'customForm') {
    if (method === 'GET') {
      return {
        statusCode: 200,
        html: renderFormPage({ title: config.formTitle, description: config.formDescription, fields: config.fields, buttonLabel: config.buttonLabel, customCss: config.customCss }),
      };
    }
    if (method === 'POST') {
      const form = await request.form();
      if (config.responseType === 'freeText') {
        return { statusCode: 200, html: actionRecordedPage(), workflowData: [[{ json: { data: { text: form.get('field-0') } } }]] };
      }
      const item = await formReturnItem({ fields: config.fields, form, mode: 'production', timezone: request.timezone, binary: request.binary });
      delete item.json.submittedAt;
      delete item.json.formMode;
      item.json = { data: item.json };
      return { statusCode: 200, html: actionRecordedPage(), workflowData: [[item]] };
    }
  }
  return { statusCode: 200, html: actionRecordedPage(), workflowData: [[{ json: { data: { approved: request.query.approved === 'true' } } }]] };
}

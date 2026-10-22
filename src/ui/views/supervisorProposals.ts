// Supervisor proposals (M36): list with diff, validation result and test run. Accepting saves the workflow (the
// activation stays), discarding discards. The test run really executes the nodes and therefore asks first.
import { confirmDialog, dialog, h, toast } from '../dom.js';
import { button, shortTime, statusWord } from '../shell.js';
import type { SupervisorDiffEntry, SupervisorProposal } from '../types.js';
import type { SupervisorBackend } from './supervisor.js';
import { t } from '../i18n.js';

const STATUS: Record<string, [string, string]> = {
  open: [t('Pending'), 'muted'],
  accepted: [t('Accepted'), 'success'],
  rejected: [t('Dismissed'), 'muted'],
  stale: [t('Outdated'), 'warning'],
};

function proposalStatus(status: string): HTMLElement {
  const [text, tone] = STATUS[status] ?? [status, 'muted'];
  return h('span', { class: `status status-${tone}` }, text);
}

const MARK: Record<string, string> = {
  'node-added': '+',
  'connection-added': '+',
  'node-removed': '−',
  'connection-removed': '−',
};

export function diffList(diff: SupervisorDiffEntry[]): HTMLElement {
  return h(
    'ul',
    { class: 'diff-list' },
    diff.map((d) => h('li', { class: `diff-${MARK[d.kind] === '+' ? 'add' : MARK[d.kind] ? 'remove' : 'change'}` }, h('span', { class: 'diff-mark', 'aria-hidden': 'true' }, MARK[d.kind] ?? '~'), h('span', null, d.text))),
  );
}

async function confirmAccept(p: SupervisorProposal): Promise<boolean> {
  return confirmDialog(
    t('Accept proposal'),
    p.kind === 'new'
      ? t('The workflow "{name}" will be created. It is inactive afterwards; activate it yourself if it fits.', { name: p.workflowName })
      : t('The workflow "{name}" will be saved with the {count} changes. Whether it is active stays unchanged.', { name: p.workflowName, count: p.diff.length }),
    t('Accept'),
  );
}

async function confirmTest(p: SupervisorProposal): Promise<boolean> {
  return confirmDialog(
    t('Start test run'),
    t('The proposed version of "{name}" is executed once manually, with pinned test data where available. All other nodes really run: they call services, send messages or write data. Nothing is saved.', { name: p.workflowName }),
    t('Start test run'),
  );
}

export function proposalCard(p: SupervisorProposal, backend: SupervisorBackend, onChange: () => void): HTMLElement {
  const actions = h('div', { class: 'finding-actions' });
  const run = async (btn: HTMLElement, action: 'accept' | 'reject' | 'test', done: (r: SupervisorProposal) => string) => {
    btn.setAttribute('disabled', '');
    try {
      const r = await backend.proposalAction!(p, action);
      toast(done(r), action === 'test' && r.testRun?.status !== 'success' ? 'error' : 'success');
      onChange();
    } catch (error) {
      toast((error as Error).message, 'error');
      btn.removeAttribute('disabled');
      if (action === 'accept') onChange();
    }
  };
  if (p.status === 'open' && p.canUse !== false) {
    if (backend.canAccept !== false && p.canAccept !== false) {
      const accept: HTMLElement = button(t('Accept'), {
        variant: 'primary',
        size: 's',
        icon: 'check',
        onclick: async () => {
          if (await confirmAccept(p)) await run(accept, 'accept', (r) => (r.kind === 'new' ? t('Workflow "{name}" created (inactive)', { name: r.workflowName }) : t('Workflow "{name}" saved', { name: r.workflowName })));
        },
      });
      actions.append(accept);
    }
    const test: HTMLElement = button(t('Test run'), {
      size: 's',
      icon: 'play',
      onclick: async () => {
        if (await confirmTest(p)) await run(test, 'test', (r) => t('Test run: {status}', { status: statusWord(r.testRun?.status).textContent ?? '' }));
      },
    });
    actions.append(test);
  }
  if ((p.status === 'open' || p.status === 'stale') && p.canUse !== false) {
    const reject: HTMLElement = button(t('Dismiss'), { size: 's', onclick: () => void run(reject, 'reject', () => t('Proposal dismissed')) });
    actions.append(reject);
  }
  if (backend.proposal) {
    actions.append(
      button(t('View version'), {
        size: 's',
        variant: 'ghost',
        icon: 'braces',
        onclick: async () => {
          try {
            const full = await backend.proposal!(p);
            await dialog(t('Proposed version: {name}', { name: p.workflowName }), h('pre', { class: 'json-view' }, JSON.stringify(full.workflow, null, 2)), { cancel: t('Close'), wide: true });
          } catch (error) {
            toast((error as Error).message, 'error');
          }
        },
      }),
    );
  }
  const pending = p.validation.issues.filter((i) => i.severity === 'error');
  const execHref = p.testRun ? backend.executionHref(p.testRun.executionId, p as { workerId?: string; projectId?: string }) : undefined;
  const target = p.kind === 'new' ? h('span', null, t('New workflow')) : p.workflowId ? h('a', { href: backend.workflowHref(p.result?.workflowId ?? p.workflowId) }, p.workflowName) : null;
  return h(
    'article',
    { class: 'finding card proposal', 'data-proposal': p.id },
    h('div', { class: 'finding-head' }, proposalStatus(p.status), h('strong', null, p.title), h('span', { class: 'spacer' }), h('span', { class: 'muted small', title: p.createdAt }, shortTime(p.createdAt))),
    h(
      'div',
      { class: 'finding-meta muted small' },
      target,
      p.workerName ? h('span', null, t('Worker {name}', { name: p.workerName })) : null,
      p.decidedAt ? h('span', null, p.decidedBy ? t('{status} {time} by {name}', { status: STATUS[p.status]?.[0] ?? p.status, time: shortTime(p.decidedAt), name: p.decidedBy }) : `${STATUS[p.status]?.[0] ?? p.status} ${shortTime(p.decidedAt)}`) : null,
      p.result?.version !== undefined ? h('span', null, t('Version {version}', { version: p.result.version })) : null,
    ),
    p.summary ? h('p', { class: 'finding-detail' }, p.summary) : null,
    diffList(p.diff),
    pending.length && p.status === 'open'
      ? h('div', { class: 'notice' }, h('strong', null, t('Before accepting')), h('ul', null, pending.map((i) => h('li', null, i.node ? `${i.node}: ${i.message}` : i.message))))
      : null,
    p.status === 'stale' ? h('p', { class: 'small status-warning' }, t('The workflow has changed since the proposal. Have a new proposal created.')) : null,
    p.testRun
      ? h('p', { class: 'small' }, `${t('Test run')} `, statusWord(p.testRun.status), ` ${shortTime(p.testRun.at)} `, execHref ? h('a', { href: execHref }, t('View execution')) : null)
      : null,
    actions,
  );
}

export async function proposalList(backend: SupervisorBackend, query: URLSearchParams, base: string): Promise<HTMLElement> {
  const status = query.get('status') ?? 'open';
  const list = await backend.proposals!({ status, workflow: query.get('workflow') ?? undefined });
  const wrap: HTMLElement = h('div', null);
  const reload = async () => wrap.replaceWith(await proposalList(backend, query, base));
  const segmented = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('Status') },
    ...([['open', t('Pending')], ['accepted', t('Accepted')], ['rejected', t('Dismissed')], ['stale', t('Outdated')]] as const).map(([value, text]) =>
      h('button', { type: 'button', class: status === value ? 'on' : '', 'aria-pressed': String(status === value), onclick: () => (location.hash = `${base}/proposals?status=${value}`) }, text),
    ),
  );
  wrap.append(
    h('div', { class: 'toolbar finding-toolbar' }, segmented, h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, t('Proposals are created for findings ("Create proposal") or in the editor in a conversation with the supervisor.'))),
    list.length
      ? h('div', { class: 'finding-list' }, list.map((p) => proposalCard(p, backend, () => void reload())))
      : h('div', { class: 'empty' }, h('p', null, status === 'open' ? t('No open proposals.') : t('No proposals in this view.'))),
  );
  return wrap;
}

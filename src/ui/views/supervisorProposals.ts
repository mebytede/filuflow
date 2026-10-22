// Vorschläge des Aufsehers (M36): Liste mit Diff, Prüfergebnis und Probelauf. Annehmen speichert den Workflow (die
// Aktivierung bleibt), Verwerfen verwirft. Der Probelauf führt die Knoten wirklich aus und fragt deshalb vorher nach.
import { confirmDialog, dialog, h, toast } from '../dom.js';
import { button, shortTime, statusWord } from '../shell.js';
import type { SupervisorDiffEntry, SupervisorProposal } from '../types.js';
import type { SupervisorBackend } from './supervisor.js';

const STATUS: Record<string, [string, string]> = {
  open: ['Offen', 'muted'],
  accepted: ['Angenommen', 'success'],
  rejected: ['Verworfen', 'muted'],
  stale: ['Veraltet', 'warning'],
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
    'Vorschlag annehmen',
    p.kind === 'new'
      ? `Der Workflow "${p.workflowName}" wird angelegt. Er ist danach inaktiv; aktivieren Sie ihn selbst, wenn er passt.`
      : `Der Workflow "${p.workflowName}" wird mit den ${p.diff.length} Änderungen gespeichert. Ob er aktiv ist, bleibt unverändert.`,
    'Annehmen',
  );
}

async function confirmTest(p: SupervisorProposal): Promise<boolean> {
  return confirmDialog(
    'Probelauf starten',
    `Der vorgeschlagene Stand von "${p.workflowName}" wird einmal manuell ausgeführt, mit festgehaltenen Testdaten, wo es sie gibt. Alle anderen Knoten laufen wirklich: Sie rufen Dienste auf, senden Nachrichten oder schreiben Daten. Gespeichert wird nichts.`,
    'Probelauf starten',
  );
}

export function proposalCard(p: SupervisorProposal, backend: SupervisorBackend, onChange: () => void): HTMLElement {
  const actions = h('div', { class: 'finding-actions' });
  const run = async (btn: HTMLElement, action: 'accept' | 'reject' | 'test', done: (r: SupervisorProposal) => string) => {
    btn.setAttribute('disabled', '');
    try {
      const r = await backend.proposalAction!(p.id, action);
      toast(done(r), action === 'test' && r.testRun?.status !== 'success' ? 'error' : 'success');
      onChange();
    } catch (error) {
      toast((error as Error).message, 'error');
      btn.removeAttribute('disabled');
      if (action === 'accept') onChange();
    }
  };
  if (p.status === 'open') {
    if (backend.canAccept !== false) {
      const accept: HTMLElement = button('Annehmen', {
        variant: 'primary',
        size: 's',
        icon: 'check',
        onclick: async () => {
          if (await confirmAccept(p)) await run(accept, 'accept', (r) => (r.kind === 'new' ? `Workflow "${r.workflowName}" angelegt (inaktiv)` : `Workflow "${r.workflowName}" gespeichert`));
        },
      });
      actions.append(accept);
    }
    const test: HTMLElement = button('Probelauf', {
      size: 's',
      icon: 'play',
      onclick: async () => {
        if (await confirmTest(p)) await run(test, 'test', (r) => `Probelauf: ${statusWord(r.testRun?.status).textContent ?? ''}`);
      },
    });
    actions.append(test);
  }
  if (p.status === 'open' || p.status === 'stale') {
    const reject: HTMLElement = button('Verwerfen', { size: 's', onclick: () => void run(reject, 'reject', () => 'Vorschlag verworfen') });
    actions.append(reject);
  }
  if (backend.proposal) {
    actions.append(
      button('Stand ansehen', {
        size: 's',
        variant: 'ghost',
        icon: 'braces',
        onclick: async () => {
          try {
            const full = await backend.proposal!(p.id);
            await dialog(`Vorgeschlagener Stand: ${p.workflowName}`, h('pre', { class: 'json-view' }, JSON.stringify(full.workflow, null, 2)), { cancel: 'Schließen', wide: true });
          } catch (error) {
            toast((error as Error).message, 'error');
          }
        },
      }),
    );
  }
  const pending = p.validation.issues.filter((i) => i.severity === 'error');
  const execHref = p.testRun ? backend.executionHref(p.testRun.executionId) : undefined;
  const target = p.kind === 'new' ? h('span', null, 'Neuer Workflow') : p.workflowId ? h('a', { href: backend.workflowHref(p.result?.workflowId ?? p.workflowId) }, p.workflowName) : null;
  return h(
    'article',
    { class: 'finding card proposal', 'data-proposal': p.id },
    h('div', { class: 'finding-head' }, proposalStatus(p.status), h('strong', null, p.title), h('span', { class: 'spacer' }), h('span', { class: 'muted small', title: p.createdAt }, shortTime(p.createdAt))),
    h(
      'div',
      { class: 'finding-meta muted small' },
      target,
      p.workerName ? h('span', null, `Worker ${p.workerName}`) : null,
      p.decidedAt ? h('span', null, `${STATUS[p.status]?.[0] ?? p.status} ${shortTime(p.decidedAt)}${p.decidedBy ? ` von ${p.decidedBy}` : ''}`) : null,
      p.result?.version !== undefined ? h('span', null, `Version ${p.result.version}`) : null,
    ),
    p.summary ? h('p', { class: 'finding-detail' }, p.summary) : null,
    diffList(p.diff),
    pending.length && p.status === 'open'
      ? h('div', { class: 'notice' }, h('strong', null, 'Vor dem Annehmen'), h('ul', null, pending.map((i) => h('li', null, i.node ? `${i.node}: ${i.message}` : i.message))))
      : null,
    p.status === 'stale' ? h('p', { class: 'small status-warning' }, 'Der Workflow wurde seit dem Vorschlag geändert. Lassen Sie einen neuen Vorschlag erstellen.') : null,
    p.testRun
      ? h('p', { class: 'small' }, 'Probelauf ', statusWord(p.testRun.status), ` ${shortTime(p.testRun.at)} `, execHref ? h('a', { href: execHref }, 'Ausführung ansehen') : null)
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
    { class: 'segmented', role: 'group', 'aria-label': 'Status' },
    ...([['open', 'Offen'], ['accepted', 'Angenommen'], ['rejected', 'Verworfen'], ['stale', 'Veraltet']] as const).map(([value, text]) =>
      h('button', { type: 'button', class: status === value ? 'on' : '', 'aria-pressed': String(status === value), onclick: () => (location.hash = `${base}/proposals?status=${value}`) }, text),
    ),
  );
  wrap.append(
    h('div', { class: 'toolbar finding-toolbar' }, segmented, h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, 'Vorschläge entstehen zu Hinweisen ("Vorschlag erstellen") oder im Editor im Gespräch mit dem Aufseher.')),
    list.length
      ? h('div', { class: 'finding-list' }, list.map((p) => proposalCard(p, backend, () => void reload())))
      : h('div', { class: 'empty' }, h('p', null, status === 'open' ? 'Keine offenen Vorschläge.' : 'Keine Vorschläge in dieser Ansicht.')),
  );
  return wrap;
}

// Supervisor in the editor (M37): conversation about the open workflow or about a new one. Answers arrive as text,
// changes and new workflows as a proposal with a diff that the person accepts or rejects here. The supervisor never
// saves on its own; proposals refer to the saved state.
import { confirmDialog, h, toast } from '../dom.js';
import { t } from '../i18n.js';
import { button, iconButton } from '../shell.js';
import type { SupervisorChatMessage, SupervisorFinding, SupervisorProposal } from '../types.js';
import { diffList } from '../views/supervisorProposals.js';
import { severityWord } from '../views/supervisor.js';

export interface SupervisorChatBackend {
  chat(body: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; workflowId?: string }): Promise<{ reply: string; proposals: SupervisorProposal[] }>;
  findings(workflowId: string): Promise<SupervisorFinding[]>;
  proposalAction(p: SupervisorProposal, action: 'accept' | 'reject'): Promise<SupervisorProposal>;
  /** Link to the "Supervisor" page */
  supervisorHref: string;
  canAccept?: boolean;
}

export interface SupervisorDrawerOptions {
  backend: SupervisorChatBackend;
  workflowId?: string;
  isDirty(): boolean;
  close(): void;
  /** After accepting: reload the editor or open the new workflow */
  onAccepted(p: SupervisorProposal): void;
}

/** Conversations are kept per workflow while the page is open */
const conversations = new Map<string, SupervisorChatMessage[]>();

export class SupervisorDrawer {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly send: HTMLButtonElement;
  private readonly messages: SupervisorChatMessage[];
  private readonly proposals = new Map<string, SupervisorProposal>();
  private busy = false;

  constructor(private readonly o: SupervisorDrawerOptions) {
    const key = o.workflowId ?? '';
    this.messages = conversations.get(key) ?? [];
    conversations.set(key, this.messages);
    this.list = h('div', { class: 'chat-messages', 'aria-live': 'polite' });
    this.input = h('textarea', {
      class: 'chat-input',
      rows: 1,
      placeholder: o.workflowId ? t('Ask about the workflow or request a change') : t('Describe the workflow you need'),
      'aria-label': t('Message to the supervisor'),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void this.submit();
        }
      },
    });
    this.send = h('button', { type: 'submit', class: 'chat-send' }, t('Send'));
    const form = h('form', { class: 'chat-form', onsubmit: (e: Event) => (e.preventDefault(), void this.submit()) }, this.input, this.send);
    const reset = iconButton('refresh-cw', t('New conversation'), () => {
      this.messages.length = 0;
      this.render();
    });
    this.el = h(
      'aside',
      { class: 'chat-drawer supervisor-drawer', 'aria-label': t('Supervisor') },
      h(
        'div',
        { class: 'chat-view' },
        h(
          'div',
          { class: 'chat-head' },
          h('div', { class: 'chat-titles' }, h('p', { class: 'chat-title' }, t('Supervisor')), h('p', { class: 'chat-subtitle' }, o.workflowId ? t('Questions, changes as proposals') : t('Draft a new workflow'))),
          reset,
          iconButton('x', t('Close supervisor'), () => o.close()),
        ),
        this.list,
        form,
        h('p', { class: 'chat-hint' }, t('The supervisor never changes anything on its own. Proposals refer to the saved state and wait for your approval.')),
      ),
    );
    this.render();
    if (o.workflowId) void this.loadFindings(o.workflowId);
  }

  focus(): void {
    this.input.focus();
  }

  private findingsBox?: HTMLElement;

  private async loadFindings(id: string): Promise<void> {
    try {
      const list = await this.o.backend.findings(id);
      if (!list.length) return;
      this.findingsBox = h(
        'div',
        { class: 'supervisor-findings' },
        h('span', { class: 'label' }, t('Open findings ({count})', { count: list.length })),
        h('ul', null, list.slice(0, 5).map((f) => h('li', null, severityWord(f.severity), ' ', f.title))),
        h('a', { href: `${this.o.backend.supervisorHref}/findings?workflow=${encodeURIComponent(id)}` }, t('View all findings')),
      );
      this.render();
    } catch {
      // Findings are only an extra
    }
  }

  private render(): void {
    const items: Node[] = [];
    if (this.findingsBox) items.push(this.findingsBox);
    if (!this.messages.length) {
      items.push(
        h(
          'p',
          { class: 'muted small' },
          this.o.workflowId
            ? t('For example: "Why did the last run fail?" or "Retry the HTTP Request three times on errors."')
            : t('For example: "Every Monday at 8 am, fetch the open tickets from our API and send them as a list to Teams via webhook."'),
        ),
      );
    }
    for (const m of this.messages) {
      items.push(h('div', { class: `chat-msg chat-${m.role === 'user' ? 'user' : 'bot'}` }, h('div', { class: 'chat-bubble' }, m.content)));
      const p = m.proposalId ? this.proposals.get(m.proposalId) : undefined;
      if (p) items.push(this.proposalBox(p));
    }
    if (this.busy) items.push(h('div', { class: 'chat-msg chat-bot chat-pending' }, h('div', { class: 'chat-bubble' }, t('The supervisor is thinking …'))));
    this.list.replaceChildren(...items);
    this.list.scrollTop = this.list.scrollHeight;
    this.send.disabled = this.busy;
  }

  private proposalBox(p: SupervisorProposal): HTMLElement {
    const actions = h('div', { class: 'finding-actions' });
    const act = async (btn: HTMLElement, action: 'accept' | 'reject') => {
      if (action === 'accept') {
        const text =
          p.kind === 'new'
            ? t('The workflow "{name}" will be created inactive and opened in the editor.', { name: p.workflowName })
            : `${t('The saved workflow will be overwritten with the {count} changes.', { count: p.diff.length })}${this.o.isDirty() ? ` ${t('Your unsaved changes in the editor will be lost.')}` : ''}`;
        if (!(await confirmDialog(t('Accept proposal'), text, t('Accept')))) return;
      }
      btn.setAttribute('disabled', '');
      try {
        const r = await this.o.backend.proposalAction(p, action);
        this.proposals.set(p.id, r);
        this.render();
        if (action === 'accept') {
          toast(r.kind === 'new' ? t('Workflow "{name}" created (inactive)', { name: r.workflowName }) : t('Proposal applied and saved'), 'success');
          this.o.onAccepted(r);
        }
      } catch (error) {
        toast((error as Error).message, 'error');
        btn.removeAttribute('disabled');
      }
    };
    if (p.status === 'open') {
      if (this.o.backend.canAccept !== false) {
        const accept: HTMLElement = button(t('Accept'), { variant: 'primary', size: 's', icon: 'check', onclick: () => void act(accept, 'accept') });
        actions.append(accept);
      }
      const reject: HTMLElement = button(t('Reject'), { size: 's', onclick: () => void act(reject, 'reject') });
      actions.append(reject);
    }
    const pending = p.validation.issues.filter((i) => i.severity === 'error');
    const state = p.status === 'open' ? null : h('span', { class: `status status-${p.status === 'accepted' ? 'success' : 'muted'}` }, p.status === 'accepted' ? t('Accepted') : p.status === 'stale' ? t('Outdated') : t('Rejected'));
    return h(
      'div',
      { class: 'supervisor-proposal', 'data-proposal': p.id },
      h('div', { class: 'finding-head' }, h('span', { class: 'label' }, p.kind === 'new' ? t('New workflow') : t('Proposal')), state),
      h('strong', null, p.title),
      diffList(p.diff),
      pending.length ? h('p', { class: 'small status-warning' }, t('Before accepting: {issues}', { issues: pending.map((i) => i.message).join('; ') })) : null,
      actions,
    );
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = '';
    this.messages.push({ role: 'user', content: text });
    this.busy = true;
    this.render();
    try {
      const res = await this.o.backend.chat({ messages: this.messages.map((m) => ({ role: m.role, content: m.content })), ...(this.o.workflowId ? { workflowId: this.o.workflowId } : {}) });
      for (const p of res.proposals) this.proposals.set(p.id, p);
      const [first, ...rest] = res.proposals;
      this.messages.push({ role: 'assistant', content: res.reply || (first ? t('I have created a proposal.') : t('No answer.')), ...(first ? { proposalId: first.id } : {}) });
      for (const p of rest) this.messages.push({ role: 'assistant', content: t('Also: {title}', { title: p.title }), proposalId: p.id });
    } catch (error) {
      this.messages.pop();
      this.input.value = text;
      toast((error as Error).message, 'error');
    } finally {
      this.busy = false;
      this.render();
      this.input.focus();
    }
  }
}

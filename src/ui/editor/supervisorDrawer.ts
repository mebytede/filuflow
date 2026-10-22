// Aufseher im Editor (M37): Gespräch über den geöffneten Workflow oder über einen neuen. Antworten kommen als Text,
// Änderungen und neue Workflows als Vorschlag mit Diff, den die Person hier annimmt oder verwirft. Der Aufseher speichert
// nie selbst; Vorschläge beziehen sich auf den gespeicherten Stand.
import { confirmDialog, h, toast } from '../dom.js';
import { button, iconButton } from '../shell.js';
import type { SupervisorChatMessage, SupervisorFinding, SupervisorProposal } from '../types.js';
import { diffList } from '../views/supervisorProposals.js';
import { severityWord } from '../views/supervisor.js';

export interface SupervisorChatBackend {
  chat(body: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; workflowId?: string }): Promise<{ reply: string; proposals: SupervisorProposal[] }>;
  findings(workflowId: string): Promise<SupervisorFinding[]>;
  proposalAction(p: SupervisorProposal, action: 'accept' | 'reject'): Promise<SupervisorProposal>;
  /** Link zur Seite "Aufseher" */
  supervisorHref: string;
  canAccept?: boolean;
}

export interface SupervisorDrawerOptions {
  backend: SupervisorChatBackend;
  workflowId?: string;
  isDirty(): boolean;
  close(): void;
  /** Nach dem Annehmen: Editor neu laden bzw. neuen Workflow öffnen */
  onAccepted(p: SupervisorProposal): void;
}

/** Gespräche bleiben je Workflow erhalten, solange die Seite offen ist */
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
      placeholder: o.workflowId ? 'Fragen Sie zum Workflow oder wünschen Sie eine Änderung' : 'Beschreiben Sie den Workflow, den Sie brauchen',
      'aria-label': 'Nachricht an den Aufseher',
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void this.submit();
        }
      },
    });
    this.send = h('button', { type: 'submit', class: 'chat-send' }, 'Senden');
    const form = h('form', { class: 'chat-form', onsubmit: (e: Event) => (e.preventDefault(), void this.submit()) }, this.input, this.send);
    const reset = iconButton('refresh-cw', 'Neues Gespräch', () => {
      this.messages.length = 0;
      this.render();
    });
    this.el = h(
      'aside',
      { class: 'chat-drawer supervisor-drawer', 'aria-label': 'Aufseher' },
      h(
        'div',
        { class: 'chat-view' },
        h(
          'div',
          { class: 'chat-head' },
          h('div', { class: 'chat-titles' }, h('p', { class: 'chat-title' }, 'Aufseher'), h('p', { class: 'chat-subtitle' }, o.workflowId ? 'Fragen, Änderungen als Vorschlag' : 'Neuen Workflow entwerfen')),
          reset,
          iconButton('x', 'Aufseher schließen', () => o.close()),
        ),
        this.list,
        form,
        h('p', { class: 'chat-hint' }, 'Der Aufseher ändert nichts selbst. Vorschläge beziehen sich auf den gespeicherten Stand und warten auf Ihre Zustimmung.'),
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
        h('span', { class: 'label' }, `Offene Hinweise (${list.length})`),
        h('ul', null, list.slice(0, 5).map((f) => h('li', null, severityWord(f.severity), ' ', f.title))),
        h('a', { href: `${this.o.backend.supervisorHref}/findings?workflow=${encodeURIComponent(id)}` }, 'Alle Hinweise ansehen'),
      );
      this.render();
    } catch {
      // Hinweise sind nur Zusatz
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
            ? 'Zum Beispiel: "Warum ist der letzte Lauf fehlgeschlagen?" oder "Wiederhole den HTTP Request bei Fehlern dreimal."'
            : 'Zum Beispiel: "Jeden Montag um 8 Uhr die offenen Tickets aus unserer API holen und als Liste per Webhook an Teams senden."',
        ),
      );
    }
    for (const m of this.messages) {
      items.push(h('div', { class: `chat-msg chat-${m.role === 'user' ? 'user' : 'bot'}` }, h('div', { class: 'chat-bubble' }, m.content)));
      const p = m.proposalId ? this.proposals.get(m.proposalId) : undefined;
      if (p) items.push(this.proposalBox(p));
    }
    if (this.busy) items.push(h('div', { class: 'chat-msg chat-bot chat-pending' }, h('div', { class: 'chat-bubble' }, 'Der Aufseher denkt nach …')));
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
            ? `Der Workflow "${p.workflowName}" wird inaktiv angelegt und im Editor geöffnet.`
            : `Der gespeicherte Workflow wird mit den ${p.diff.length} Änderungen überschrieben.${this.o.isDirty() ? ' Ihre ungespeicherten Änderungen im Editor gehen dabei verloren.' : ''}`;
        if (!(await confirmDialog('Vorschlag annehmen', text, 'Annehmen'))) return;
      }
      btn.setAttribute('disabled', '');
      try {
        const r = await this.o.backend.proposalAction(p, action);
        this.proposals.set(p.id, r);
        this.render();
        if (action === 'accept') {
          toast(r.kind === 'new' ? `Workflow "${r.workflowName}" angelegt (inaktiv)` : 'Vorschlag übernommen und gespeichert', 'success');
          this.o.onAccepted(r);
        }
      } catch (error) {
        toast((error as Error).message, 'error');
        btn.removeAttribute('disabled');
      }
    };
    if (p.status === 'open') {
      if (this.o.backend.canAccept !== false) {
        const accept: HTMLElement = button('Annehmen', { variant: 'primary', size: 's', icon: 'check', onclick: () => void act(accept, 'accept') });
        actions.append(accept);
      }
      const reject: HTMLElement = button('Verwerfen', { size: 's', onclick: () => void act(reject, 'reject') });
      actions.append(reject);
    }
    const pending = p.validation.issues.filter((i) => i.severity === 'error');
    const state = p.status === 'open' ? null : h('span', { class: `status status-${p.status === 'accepted' ? 'success' : 'muted'}` }, p.status === 'accepted' ? 'Angenommen' : p.status === 'stale' ? 'Veraltet' : 'Verworfen');
    return h(
      'div',
      { class: 'supervisor-proposal', 'data-proposal': p.id },
      h('div', { class: 'finding-head' }, h('span', { class: 'label' }, p.kind === 'new' ? 'Neuer Workflow' : 'Vorschlag'), state),
      h('strong', null, p.title),
      diffList(p.diff),
      pending.length ? h('p', { class: 'small status-warning' }, `Vor dem Annehmen: ${pending.map((i) => i.message).join('; ')}`) : null,
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
      this.messages.push({ role: 'assistant', content: res.reply || (first ? 'Ich habe einen Vorschlag erstellt.' : 'Keine Antwort.'), ...(first ? { proposalId: first.id } : {}) });
      for (const p of rest) this.messages.push({ role: 'assistant', content: `Außerdem: ${p.title}`, proposalId: p.id });
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

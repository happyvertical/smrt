/**
 * A stateful in-memory mail server for triage and sync tests. It implements
 * the `@happyvertical/email` write-back and change-feed contracts with JMAP's
 * semantics (absolute patches, per-message failures, mailbox membership), so a
 * test can write a change through triage and then let sync read the server's
 * truth back.
 */

import type {
  ChangeFeedOptions,
  ChangeFeedResult,
  EmailClientCapabilities,
  EmailMessage,
  FlagChange,
  LabelChange,
  WriteBackResult,
} from '@happyvertical/email';

export const MAILBOXES = ['INBOX', 'Archive', 'Junk', 'Projects'] as const;

interface Stored {
  id: string;
  folders: string[];
  flags: string[];
}

export class FakeMailServer {
  readonly messages = new Map<string, Stored>();
  /** Ids the server refuses to write, with the code it reports. */
  readonly refuse = new Map<string, string>();
  calls: Array<{ method: string; ids: string[]; arg?: unknown }> = [];
  writeBack: EmailClientCapabilities['writeBack'] | undefined = {
    flags: true,
    keywords: true,
    labels: true,
    archive: true,
    spam: true,
  };
  /** Ids getMessage fails for. */
  readonly unreadable = new Set<string>();
  private version = 0;
  private changed = new Set<string>();

  add(id: string, folders: string[] = ['INBOX'], flags: string[] = []): this {
    this.messages.set(id, { id, folders: [...folders], flags: [...flags] });
    this.changed.add(id);
    return this;
  }

  /** Mark a message as changed on the server by something other than triage. */
  touch(id: string): this {
    this.changed.add(id);
    this.version++;
    return this;
  }

  message(id: string): EmailMessage {
    const m = this.messages.get(id);
    if (!m) throw new Error(`no such message ${id}`);
    return {
      id,
      messageId: `<${id}@example.com>`,
      threadId: `thread-${id}`,
      from: { address: 'alice@example.com', name: 'Alice' },
      to: [{ address: 'me@example.com' }],
      subject: `Subject ${id}`,
      date: new Date('2026-01-01T10:00:00Z'),
      text: `Body ${id}`,
      html: `<p>Body ${id}</p>`,
      folder: m.folders[0],
      folders: [...m.folders],
      flags: [...m.flags],
      size: 10,
    };
  }

  private patch(
    method: string,
    ids: string | string[],
    arg: unknown,
    apply: (m: Stored) => void,
  ): WriteBackResult {
    const list = Array.isArray(ids) ? ids : [ids];
    this.calls.push({ method, ids: list, arg });
    const result: WriteBackResult = { updated: [], failed: [] };
    for (const id of list) {
      const m = this.messages.get(id);
      if (!m) {
        result.failed.push({ id, code: 'notFound' });
      } else if (this.refuse.has(id)) {
        result.failed.push({ id, code: this.refuse.get(id) as string });
      } else {
        apply(m);
        this.changed.add(id);
        result.updated.push(id);
      }
    }
    this.version++;
    return result;
  }

  private static setFlag(m: Stored, flag: string, on: boolean): void {
    const has = m.flags.some((f) => f.toLowerCase() === flag.toLowerCase());
    if (on && !has) m.flags.push(flag);
    if (!on && has)
      m.flags = m.flags.filter((f) => f.toLowerCase() !== flag.toLowerCase());
  }

  private mailbox(name: string): string {
    if (!(MAILBOXES as readonly string[]).includes(name)) {
      throw new Error(`Folder not found: ${name}`);
    }
    return name;
  }

  readonly client = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    getAdapter: () => 'jmap',
    getCapabilities: async (): Promise<EmailClientCapabilities> => ({
      send: true,
      receive: true,
      folders: true,
      search: true,
      markRead: true,
      move: true,
      delete: true,
      threads: true,
      oauth: false,
      changeFeed: true,
      ...(this.writeBack ? { writeBack: this.writeBack } : {}),
    }),
    getMessage: async (id: string) => {
      if (this.unreadable.has(id)) throw new Error('read-back failed');
      return this.message(id);
    },
    updateFlags: async (ids: string | string[], change: FlagChange) =>
      this.patch('updateFlags', ids, change, (m) => {
        for (const f of change.add ?? []) FakeMailServer.setFlag(m, f, true);
        for (const f of change.remove ?? [])
          FakeMailServer.setFlag(m, f, false);
      }),
    updateLabels: async (ids: string | string[], change: LabelChange) => {
      const add = (change.add ?? []).map((n) => this.mailbox(n));
      const remove = (change.remove ?? []).map((n) => this.mailbox(n));
      return this.patch('updateLabels', ids, change, (m) => {
        for (const n of add) if (!m.folders.includes(n)) m.folders.push(n);
        m.folders = m.folders.filter((n) => !remove.includes(n));
      });
    },
    archive: async (ids: string | string[]) =>
      this.patch('archive', ids, undefined, (m) => {
        m.folders = m.folders.filter((n) => n !== 'INBOX');
        if (!m.folders.includes('Archive')) m.folders.push('Archive');
      }),
    markSpam: async (ids: string | string[], spam = true) =>
      this.patch('markSpam', ids, spam, (m) => {
        m.folders = [spam ? 'Junk' : 'INBOX'];
        FakeMailServer.setFlag(m, '$junk', spam);
        FakeMailServer.setFlag(m, '$notjunk', !spam);
      }),
    getChanges: async (
      options: ChangeFeedOptions = {},
    ): Promise<ChangeFeedResult> => {
      const initial = options.cursor === undefined;
      const ids = initial ? [...this.messages.keys()] : [...this.changed];
      this.changed.clear();
      return {
        status: 'ok',
        cursor: `v${this.version}`,
        hasMore: false,
        initial,
        added: initial ? ids.map((id) => this.message(id)) : [],
        changed: initial
          ? []
          : ids
              .filter((id) => this.messages.has(id))
              .map((id) => this.message(id)),
        removed: [],
      };
    },
  };
}

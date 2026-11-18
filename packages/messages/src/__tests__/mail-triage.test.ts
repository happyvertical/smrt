/**
 * Triage write-back (#5131). The only mocked boundary is the mail server
 * (`FakeMailServer`, which keeps real state and JMAP semantics); the account,
 * folders, emails and sync run for real against in-memory SQLite.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../models/Account';
import '../models/Message';
import { runWithMailSystemAccess } from '../access.js';
import { EmailAccountCollection } from '../collections/EmailAccountCollection';
import { EmailCollection } from '../collections/EmailCollection';
import { EmailFolderCollection } from '../collections/EmailFolderCollection';
import { MailWriteBackUnsupportedError } from '../index.js';
import type { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { prepareMessageParents } from './fk-fixtures.js';
import { FakeMailServer } from './helpers/fake-mail-server';

let db: DatabaseInterface;
let counter = 0;
// The sync lane reloads the account from the store, so the client is wired by
// account id on the prototype rather than on one instance.
const servers = new Map<string, FakeMailServer>();

async function makeAccount(
  server: FakeMailServer,
  overrides: Record<string, unknown> = {},
): Promise<EmailAccount> {
  const n = ++counter;
  const account = new EmailAccount({
    name: `Triage Account ${n}`,
    email: `triage${n}@example.com`,
    providerType: 'jmap',
    db,
    ...overrides,
  });
  await account.initialize();
  await account.save();
  servers.set(account.id as string, server);
  return account;
}

async function reload(account: EmailAccount): Promise<EmailAccount> {
  const accounts = await EmailAccountCollection.create({ db });
  const fresh = (await accounts.get({ id: account.id })) as EmailAccount;
  servers.set(fresh.id as string, servers.get(account.id as string) as never);
  return fresh;
}

async function rows(account: EmailAccount): Promise<Map<string, Email>> {
  const emails = await EmailCollection.create({ db });
  const list = await runWithMailSystemAccess(
    async () =>
      (await emails.list({ where: { accountId: account.id } })) as Email[],
  );
  return new Map(list.map((e) => [e.providerMessageId, e]));
}

const flagsOf = (e: Email): string[] =>
  (JSON.parse(e.flags || '[]') as string[]).map((f) => f.toLowerCase()).sort();

/** The server-derived fields a sync writes, for comparing rows. */
const synced = (e: Email) => ({
  flags: flagsOf(e),
  labels: (JSON.parse(e.labels || '[]') as string[]).sort(),
  folderPath: e.folderPath,
  folderId: e.folderId,
  isRead: e.isRead,
  isFlagged: e.isFlagged,
});

async function seeded(
  ids: string[] = ['m1', 'm2', 'm3'],
): Promise<{ server: FakeMailServer; account: EmailAccount }> {
  const server = new FakeMailServer();
  for (const id of ids) server.add(id);
  const account = await makeAccount(server);
  await account.syncChanges();
  return { server, account };
}

beforeEach(async () => {
  db = await getTestDatabase();
  await prepareMessageParents(db);
  servers.clear();
  vi.spyOn(EmailAccount.prototype, 'createClient').mockImplementation(
    async function (this: EmailAccount) {
      return servers.get(this.id as string)?.client as never;
    },
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (db && typeof db.close === 'function') await db.close();
});

describe('EmailAccount.triage: actions', () => {
  it('marks read and unread on the server, then locally', async () => {
    const { server, account } = await seeded();
    const [m1] = [(await rows(account)).get('m1') as Email];
    expect(m1.isRead).toBe(false);

    const read = await account.triage({ kind: 'markRead' }, [m1.id as string]);
    expect(read).toEqual({
      action: 'markRead',
      accountId: account.id,
      updated: [m1.id],
      failed: [],
      stale: [],
    });
    expect(server.calls.at(-1)).toMatchObject({
      method: 'updateFlags',
      ids: ['m1'],
      arg: { add: ['\\Seen'] },
    });
    let stored = (await rows(account)).get('m1') as Email;
    expect(stored.isRead).toBe(true);
    expect(flagsOf(stored)).toEqual(['\\seen']);
    // Only the targeted message changed.
    expect(((await rows(account)).get('m2') as Email).isRead).toBe(false);

    await account.triage({ kind: 'markUnread' }, [m1.id as string]);
    stored = (await rows(account)).get('m1') as Email;
    expect(stored.isRead).toBe(false);
    expect(flagsOf(stored)).toEqual([]);
  });

  it('stars and unstars', async () => {
    const { server, account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    await account.triage({ kind: 'star' }, [id]);
    expect(server.messages.get('m1')?.flags).toEqual(['\\Flagged']);
    expect(((await rows(account)).get('m1') as Email).isFlagged).toBe(true);
    await account.triage({ kind: 'unstar' }, [id]);
    expect(((await rows(account)).get('m1') as Email).isFlagged).toBe(false);
  });

  it('archives: leaves the inbox, keeps other labels, updates folder counts', async () => {
    const { server, account } = await seeded();
    server.add('m4', ['INBOX', 'Projects']);
    await account.syncChanges();
    const m4 = (await rows(account)).get('m4') as Email;
    const result = await account.triage({ kind: 'archive' }, [m4.id as string]);
    expect(result.updated).toEqual([m4.id]);
    const stored = (await rows(account)).get('m4') as Email;
    expect(JSON.parse(stored.labels).sort()).toEqual(['Archive', 'Projects']);
    expect(stored.folderPath).toBe('Projects');
    const folders = await (
      await EmailFolderCollection.create({ db })
    ).getByAccount(account.id as string);
    const inbox = folders.find((f) => f.path === 'INBOX');
    const projects = folders.find((f) => f.path === 'Projects');
    expect(inbox?.messageCount).toBe(3);
    expect(projects?.messageCount).toBe(1);
    expect(stored.folderId).not.toBe('');
  });

  it('marks and unmarks spam', async () => {
    const { account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    await account.triage({ kind: 'markSpam' }, [id]);
    let stored = (await rows(account)).get('m1') as Email;
    expect(stored.folderPath).toBe('Junk');
    expect(flagsOf(stored)).toEqual(['$junk']);
    await account.triage({ kind: 'unmarkSpam' }, [id]);
    stored = (await rows(account)).get('m1') as Email;
    expect(stored.folderPath).toBe('INBOX');
    expect(flagsOf(stored)).toEqual(['$notjunk']);
  });

  it('adds and removes labels, and moves to exactly one folder', async () => {
    const { server, account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    await account.triage({ kind: 'addLabels', labels: ['Projects'] }, [id]);
    expect(
      JSON.parse(((await rows(account)).get('m1') as Email).labels).sort(),
    ).toEqual(['INBOX', 'Projects']);
    await account.triage({ kind: 'removeLabels', labels: ['INBOX'] }, [id]);
    expect(
      JSON.parse(((await rows(account)).get('m1') as Email).labels),
    ).toEqual(['Projects']);

    const m2 = ((await rows(account)).get('m2') as Email).id as string;
    server.messages.get('m2')?.folders.push('Archive');
    server.touch('m2');
    await account.syncChanges();
    await account.triage({ kind: 'move', folder: 'Projects' }, [m2, id]);
    for (const pid of ['m1', 'm2']) {
      expect(server.messages.get(pid)?.folders).toEqual(['Projects']);
      const stored = (await rows(account)).get(pid) as Email;
      expect(stored.folderPath).toBe('Projects');
      expect(JSON.parse(stored.labels)).toEqual(['Projects']);
    }
  });

  it('resolves a move target by case or name, and treats the current folder as accepted', async () => {
    const { server, account } = await seeded(['m1', 'm2']);
    server.add('m9', ['Projects']);
    server.touch('m9');
    await account.syncChanges();
    const map = await rows(account);
    const m1 = (map.get('m1') as Email).id as string;
    const m2 = (map.get('m2') as Email).id as string;
    const same = await account.triage({ kind: 'move', folder: 'inbox' }, [m1]);
    expect(same).toMatchObject({ updated: [m1], failed: [], stale: [] });
    expect(server.messages.get('m1')?.folders).toEqual(['INBOX']);
    const moved = await account.triage({ kind: 'move', folder: 'projects' }, [
      m2,
    ]);
    expect(moved).toMatchObject({ updated: [m2], failed: [] });
    expect(server.messages.get('m2')?.folders).toEqual(['Projects']);
    expect(((await rows(account)).get('m2') as Email).folderPath).toBe(
      'Projects',
    );
  });

  it('rejects an unknown action or an empty label list without calling the server', async () => {
    const { server, account } = await seeded();
    const before = server.calls.length;
    await expect(
      account.triage({ kind: 'addLabels', labels: [] }, ['x']),
    ).rejects.toThrow(/non-empty/);
    await expect(
      account.triage({ kind: 'move', folder: ' ' }, ['x']),
    ).rejects.toThrow(/non-empty/);
    await expect(
      account.triage({ kind: 'explode' } as never, ['x']),
    ).rejects.toThrow(/Unknown triage action/);
    expect(server.calls.length).toBe(before);
  });

  it('is available on the Email row', async () => {
    const { server, account } = await seeded();
    // Email.triage loads its account afresh, so stub the client at the class.
    vi.spyOn(EmailAccount.prototype, 'createClient').mockResolvedValue(
      server.client as never,
    );
    const email = (await rows(account)).get('m1') as Email;
    await email.triage({ kind: 'star' });
    expect(((await rows(account)).get('m1') as Email).isFlagged).toBe(true);
    server.refuse.set('m2', 'forbidden');
    const m2 = (await rows(account)).get('m2') as Email;
    await expect(m2.triage({ kind: 'star' })).rejects.toThrow(/forbidden/);
  });
});

describe('EmailAccount.triage: partial failure', () => {
  it('updates only the ids the server accepted and reports the rest', async () => {
    const { server, account } = await seeded();
    server.refuse.set('m2', 'forbidden');
    const map = await rows(account);
    const ids = ['m1', 'm2', 'm3'].map(
      (p) => (map.get(p) as Email).id as string,
    );

    const result = await account.triage({ kind: 'markRead' }, ids);

    expect(result.updated.sort()).toEqual([ids[0], ids[2]].sort());
    expect(result.failed).toEqual([{ id: ids[1], code: 'forbidden' }]);
    const after = await rows(account);
    expect((after.get('m1') as Email).isRead).toBe(true);
    expect((after.get('m2') as Email).isRead).toBe(false);
    expect(flagsOf(after.get('m2') as Email)).toEqual([]);
    expect((after.get('m3') as Email).isRead).toBe(true);
  });

  it('reports unknown, foreign-account and unsynced rows without sending them', async () => {
    const { server, account } = await seeded(['m1']);
    const other = await makeAccount(new FakeMailServer().add('o1'));
    await other.syncChanges();
    const foreign = ((await rows(other)).get('o1') as Email).id as string;

    const emails = await EmailCollection.create({ db });
    const local = new (await import('../models/Email')).Email({
      db,
      accountId: account.id as string,
      subject: 'draft only',
    });
    await local.initialize();
    await local.save();
    void emails;

    const own = ((await rows(account)).get('m1') as Email).id as string;
    const before = server.calls.length;
    const result = await account.triage({ kind: 'star' }, [
      own,
      'no-such-id',
      foreign,
      local.id as string,
    ]);
    expect(result.updated).toEqual([own]);
    expect(result.failed.map((f) => [f.id, f.code]).sort()).toEqual(
      [
        ['no-such-id', 'notFound'],
        [foreign, 'notFound'],
        [local.id, 'notSynced'],
      ].sort(),
    );
    expect(server.calls.slice(before)[0].ids).toEqual(['m1']);
    // The other account's message was never touched.
    expect(((await rows(other)).get('o1') as Email).isFlagged).toBe(false);
  });

  it('reports ids the server returned no outcome for', async () => {
    const { server, account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    vi.spyOn(server.client, 'updateFlags').mockResolvedValue({
      updated: [],
      failed: [],
    });
    const result = await account.triage({ kind: 'markRead' }, [id]);
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([
      expect.objectContaining({ id, code: 'unknown' }),
    ]);
    expect(((await rows(account)).get('m1') as Email).isRead).toBe(false);
  });

  it('reports a move partially when a later server call throws (deleted mailbox label)', async () => {
    const { server, account } = await seeded(['m1', 'm2']);
    server.messages.get('m2')?.folders.push('Ghost');
    server.touch('m2');
    await account.syncChanges();
    const map = await rows(account);
    const m1 = (map.get('m1') as Email).id as string;
    const m2 = (map.get('m2') as Email).id as string;
    const result = await account.triage({ kind: 'move', folder: 'Projects' }, [
      m1,
      m2,
    ]);
    expect(result.updated).toEqual([m1]);
    expect(result.failed).toEqual([
      expect.objectContaining({ id: m2, code: 'serverError' }),
    ]);
    expect(JSON.stringify(result.failed)).not.toMatch(/Ghost|Folder not found/);
    expect(server.messages.get('m1')?.folders).toEqual(['Projects']);
    const after = await rows(account);
    expect((after.get('m1') as Email).folderPath).toBe('Projects');
    expect(synced(after.get('m2') as Email).labels).toEqual(['Ghost', 'INBOX']);
  });

  it('leaves rows unchanged and throws when the server call itself fails', async () => {
    const { account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    await expect(
      account.triage({ kind: 'addLabels', labels: ['Nope'] }, [id]),
    ).rejects.toThrow(/Folder not found/);
    expect(synced((await rows(account)).get('m1') as Email).labels).toEqual([
      'INBOX',
    ]);
  });

  it('reports a row as stale when the server accepted but the read-back failed', async () => {
    const { server, account } = await seeded();
    server.unreadable.add('m1');
    const id = ((await rows(account)).get('m1') as Email).id as string;
    const result = await account.triage({ kind: 'markRead' }, [id]);
    expect(result).toMatchObject({ updated: [], failed: [], stale: [id] });
    expect(server.messages.get('m1')?.flags).toEqual(['\\Seen']);
    expect(((await rows(account)).get('m1') as Email).isRead).toBe(false);
    // The next sync brings the row up to date.
    await account.syncChanges();
    expect(((await rows(account)).get('m1') as Email).isRead).toBe(true);
  });

  it('marks the account for reconnection when the server refuses the sign-in', async () => {
    const { server, account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    vi.spyOn(server.client, 'updateFlags').mockRejectedValue(
      Object.assign(new Error('Authentication failed'), { code: 'EAUTH' }),
    );
    await expect(account.triage({ kind: 'markRead' }, [id])).rejects.toThrow(
      /Authentication failed/,
    );
    expect((await reload(account)).needsReconnect).toBe(true);
  });
});

describe('EmailAccount.triage: read-back and partial auth failures', () => {
  it('reports stale and flags reconnect when read-back is refused after write-back', async () => {
    const { server, account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    vi.spyOn(server.client, 'getMessage').mockRejectedValue(
      Object.assign(new Error('Authentication failed'), { code: 'EAUTH' }),
    );
    const result = await account.triage({ kind: 'markRead' }, [id]);
    expect(result).toMatchObject({
      updated: [],
      failed: [],
      stale: [id],
      needsReconnect: true,
    });
    expect(server.messages.get('m1')?.flags).toEqual(['\\Seen']);
    expect((await reload(account)).needsReconnect).toBe(true);
  });

  it('returns the partial result when a later group is refused the sign-in', async () => {
    const { server, account } = await seeded();
    const list = await rows(account);
    const m1 = list.get('m1') as Email;
    const m2 = list.get('m2') as Email;
    // Different current mailboxes make two server calls for one move.
    m2.labels = JSON.stringify(['INBOX', 'Other']);
    await runWithMailSystemAccess(() => m2.save());
    const real = server.client.updateLabels!.bind(server.client);
    let n = 0;
    vi.spyOn(server.client, 'updateLabels').mockImplementation(
      async (...args: Parameters<typeof real>) => {
        if (++n === 1) return real(...args);
        throw Object.assign(new Error('Authentication failed'), {
          code: 'EAUTH',
        });
      },
    );
    const result = await account.triage({ kind: 'move', folder: 'Projects' }, [
      m1.id as string,
      m2.id as string,
    ]);
    expect(result.needsReconnect).toBe(true);
    expect(result.updated.length + result.stale.length).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect((await reload(account)).needsReconnect).toBe(true);
  });
});

describe('EmailAccount.triage: no-op calls', () => {
  it('still throws when the only server call fails auth and other rows were already in place', async () => {
    const { server, account } = await seeded();
    const list = await rows(account);
    const m1 = list.get('m1') as Email;
    const m2 = list.get('m2') as Email;
    m2.labels = JSON.stringify(['INBOX', 'Other']);
    await runWithMailSystemAccess(() => m2.save());
    vi.spyOn(server.client, 'updateLabels').mockRejectedValue(
      Object.assign(new Error('Authentication failed'), { code: 'EAUTH' }),
    );
    // m1 is already exactly in INBOX (a local no-op); m2 needs the server.
    await expect(
      account.triage({ kind: 'move', folder: 'INBOX' }, [
        m1.id as string,
        m2.id as string,
      ]),
    ).rejects.toThrow(/Authentication failed/);
    expect((await reload(account)).needsReconnect).toBe(true);
  });
});

describe('EmailAccount.triage: provider capabilities', () => {
  it('throws a typed error, changing nothing, when the provider has no write-back', async () => {
    const { server, account } = await seeded();
    server.writeBack = undefined;
    const id = ((await rows(account)).get('m1') as Email).id as string;
    const before = server.calls.length;
    const error = await account
      .triage({ kind: 'markRead' }, [id])
      .catch((e) => e);
    expect(error).toBeInstanceOf(MailWriteBackUnsupportedError);
    expect(error).toMatchObject({
      code: 'WRITE_BACK_UNSUPPORTED',
      action: 'markRead',
      capability: 'flags',
      providerType: 'jmap',
    });
    expect(server.calls.length).toBe(before);
    expect(((await rows(account)).get('m1') as Email).isRead).toBe(false);
  });

  it('checks the capability the action needs', async () => {
    const { server, account } = await seeded();
    server.writeBack = { flags: true };
    const id = ((await rows(account)).get('m1') as Email).id as string;
    await expect(
      account.triage({ kind: 'archive' }, [id]),
    ).rejects.toMatchObject({ capability: 'archive' });
    await expect(
      account.triage({ kind: 'move', folder: 'Projects' }, [id]),
    ).rejects.toMatchObject({ capability: 'labels' });
    await expect(
      account.triage({ kind: 'markSpam' }, [id]),
    ).rejects.toMatchObject({ capability: 'spam' });
    await expect(account.triage({ kind: 'star' }, [id])).resolves.toMatchObject(
      {
        updated: [id],
      },
    );
  });

  it('refuses inactive and needs-reconnect accounts', async () => {
    const { account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    account.isActive = false;
    await expect(account.triage({ kind: 'star' }, [id])).rejects.toThrow(
      /inactive/,
    );
  });
});

describe('EmailAccount.triage: idempotency and sync convergence', () => {
  it('repeating a call changes nothing', async () => {
    const { account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    await account.triage({ kind: 'archive' }, [id]);
    const first = synced((await rows(account)).get('m1') as Email);
    const again = await account.triage({ kind: 'archive' }, [id]);
    expect(again.updated).toEqual([id]);
    expect(synced((await rows(account)).get('m1') as Email)).toEqual(first);
  });

  it('the next sync leaves a triaged row exactly as triage stored it', async () => {
    const { server, account } = await seeded();
    const map = await rows(account);
    const id = (p: string) => (map.get(p) as Email).id as string;
    await account.triage({ kind: 'markRead' }, [id('m1')]);
    await account.triage({ kind: 'star' }, [id('m1'), id('m2')]);
    await account.triage({ kind: 'archive' }, [id('m2')]);
    await account.triage({ kind: 'markSpam' }, [id('m3')]);
    await account.triage({ kind: 'addLabels', labels: ['Projects'] }, [
      id('m1'),
    ]);

    const afterTriage = new Map(
      [...(await rows(account))].map(([k, v]) => [k, synced(v)]),
    );
    // The server reports every touched message as changed: sync applies them.
    for (const pid of ['m1', 'm2', 'm3']) server.messages.get(pid);
    const result = await (await reload(account)).syncChanges();
    expect(result.changed).toBeGreaterThanOrEqual(3);
    const afterSync = new Map(
      [...(await rows(account))].map(([k, v]) => [k, synced(v)]),
    );
    expect(afterSync).toEqual(afterTriage);

    // And again: nothing more to say, nothing flaps.
    await (await reload(account)).syncChanges();
    expect(
      new Map([...(await rows(account))].map(([k, v]) => [k, synced(v)])),
    ).toEqual(afterTriage);
  });

  it('a stale sync batch after triage is corrected by the next one', async () => {
    const { server, account } = await seeded(['m1']);
    const id = ((await rows(account)).get('m1') as Email).id as string;
    const stale = server.message('m1'); // server state before the triage
    await account.triage({ kind: 'markRead' }, [id]);
    const fresh = server.message('m1');

    // A sync that was fetched before the triage lands after it...
    const feed = vi
      .spyOn(server.client, 'getChanges')
      .mockResolvedValueOnce({
        status: 'ok',
        cursor: 'late',
        hasMore: false,
        initial: false,
        added: [],
        changed: [stale],
        removed: [],
      })
      .mockResolvedValueOnce({
        status: 'ok',
        cursor: 'later',
        hasMore: false,
        initial: false,
        added: [],
        changed: [fresh],
        removed: [],
      });
    await account.syncChanges();
    expect(((await rows(account)).get('m1') as Email).isRead).toBe(false);
    // ...and the server's next report of the change converges the row.
    await (await reload(account)).syncChanges();
    expect(((await rows(account)).get('m1') as Email).isRead).toBe(true);
    expect(feed).toHaveBeenCalledTimes(2);
  });

  it('serializes with a sync of the same account', async () => {
    const { server, account } = await seeded();
    const id = ((await rows(account)).get('m1') as Email).id as string;
    const order: string[] = [];
    const getChanges = server.client.getChanges;
    vi.spyOn(server.client, 'getChanges').mockImplementation(async (o) => {
      order.push('sync:start');
      await new Promise((r) => setTimeout(r, 20));
      const r = await getChanges(o);
      order.push('sync:end');
      return r;
    });
    const updateFlags = server.client.updateFlags;
    vi.spyOn(server.client, 'updateFlags').mockImplementation(async (...a) => {
      order.push('triage');
      return updateFlags(...a);
    });
    const sync = account.syncChanges();
    await vi.waitFor(() => expect(order).toContain('sync:start'));
    await Promise.all([sync, account.triage({ kind: 'markRead' }, [id])]);
    expect(order).toEqual(['sync:start', 'sync:end', 'triage']);
  });
});

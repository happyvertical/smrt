/**
 * Triage write-back reads state back from the server but leaves the row's
 * class alone (#5681): a synced provider draft stays a draft, and received
 * mail stays received, whatever flags the server reports after the change.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../models/Account';
import '../models/Message';
import { runWithMailSystemAccess } from '../access.js';
import { EmailAccountCollection } from '../collections/EmailAccountCollection';
import { EmailCollection } from '../collections/EmailCollection';
import type { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { prepareMessageParents } from './fk-fixtures.js';
import { FakeMailServer } from './helpers/fake-mail-server';

let db: DatabaseInterface;
let server: FakeMailServer;

const byProviderId = async (account: EmailAccount, id: string) => {
  const emails = await EmailCollection.create({ db });
  const list = await runWithMailSystemAccess(
    async () =>
      (await emails.list({ where: { accountId: account.id } })) as Email[],
  );
  return list.find((e) => e.providerMessageId === id) as Email;
};

/** A provider that rewrites the draft flag whenever a message is touched. */
function flipDraftFlagOnWrite(id: string, draft: boolean) {
  const { updateFlags, updateLabels } = server.client;
  const rewrite = () => {
    const m = server.messages.get(id);
    if (!m) return;
    m.flags = m.flags.filter((f) => f.toLowerCase() !== '\\draft');
    if (draft) m.flags.push('\\Draft');
  };
  server.client.updateFlags = async (...args) => {
    const result = await updateFlags(...args);
    rewrite();
    return result;
  };
  server.client.updateLabels = async (...args) => {
    const result = await updateLabels(...args);
    rewrite();
    return result;
  };
}

async function sync(): Promise<EmailAccount> {
  const account = new EmailAccount({
    name: 'Draft Account',
    email: 'draft@example.com',
    providerType: 'jmap',
    db,
  });
  await account.initialize();
  await account.save();
  await account.syncChanges();
  const accounts = await EmailAccountCollection.create({ db });
  return (await accounts.get({ id: account.id })) as EmailAccount;
}

beforeEach(async () => {
  db = await getTestDatabase();
  await prepareMessageParents(db);
  server = new FakeMailServer();
  vi.spyOn(EmailAccount.prototype, 'createClient').mockImplementation(
    async () => server.client as never,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (db && typeof db.close === 'function') await db.close();
});

describe('triage write-back keeps the row class (#5681)', () => {
  it.each([
    ['markRead', { kind: 'markRead' }],
    ['addLabels', { kind: 'addLabels', labels: ['Projects'] }],
    ['move', { kind: 'move', folder: 'Projects' }],
  ] as const)('keeps a synced provider draft a draft after %s', async (_n, action) => {
    server.add('d1', ['INBOX'], ['\\Draft']);
    const account = await sync();
    const before = await byProviderId(account, 'd1');
    expect(before.isDraft).toBe(true);
    flipDraftFlagOnWrite('d1', false);
    await account.triage(action, [before.id as string]);
    const after = await byProviderId(account, 'd1');
    expect(after.isDraft).toBe(true);
    expect(after.sendStatus).toBe(before.sendStatus);
  });

  it('keeps received mail received when the server reports a draft flag', async () => {
    server.add('r1', ['INBOX'], []);
    const account = await sync();
    const before = await byProviderId(account, 'r1');
    expect(before.isDraft).toBe(false);
    flipDraftFlagOnWrite('r1', true);
    await account.triage({ kind: 'markRead' }, [before.id as string]);
    const after = await byProviderId(account, 'r1');
    expect(after.isDraft).toBe(false);
    expect(after.isRead).toBe(true);
  });

  it('still applies the read, flag and label state the server reports', async () => {
    server.add('d1', ['INBOX'], ['\\Draft']);
    const account = await sync();
    const before = await byProviderId(account, 'd1');
    await account.triage({ kind: 'star' }, [before.id as string]);
    const after = await byProviderId(account, 'd1');
    expect(after.isFlagged).toBe(true);
    expect(after.isDraft).toBe(true);
  });
});

/**
 * Creating a row whose stored status is `sent` needs the `send` scope on an
 * owned account (#5681): replies and forwards quote sent mail, and the only
 * ways a sent record comes into being are the send path and trusted sync.
 */

import { withTenant } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { MailAccessError, runWithMailSystemAccess } from '../access.js';
import { Email } from '../models/Email';
import { useMailDraftScopeFixture } from './helpers/mail-draft-scope-fixture.js';

describe('creating a sent row (#5681)', () => {
  const f = useMailDraftScopeFixture();

  const newSent = async (accountId: string, subject = 'planted') => {
    const email = new Email({
      ...f.options,
      tenantId: f.tenantId,
      accountId,
      subject,
      sendStatus: 'sent',
      isDraft: false,
    });
    await email.initialize();
    return email;
  };

  it.each([
    ['no principal', () => null],
    ['a stranger', () => f.principal(f.stranger)],
    ['a read grantee', () => f.principal(f.stranger, { scopes: ['read'] })],
    ['a drafter', () => f.principal(f.drafter)],
  ])('refuses to create a sent row as %s', async (_label, who) => {
    await f.grant(f.stranger.id, 'read');
    await expect(
      f.as(who(), async () => (await newSent(f.ownedId)).save()),
    ).rejects.toBeInstanceOf(MailAccessError);
    expect(await f.countBySubject('planted')).toBe(0);
  });

  it('refuses a triage grantee', async () => {
    await f.grant(f.stranger.id, 'read');
    await f.grant(f.stranger.id, 'triage');
    await expect(
      f.as(f.principal(f.stranger), async () =>
        (await newSent(f.ownedId)).save(),
      ),
    ).rejects.toBeInstanceOf(MailAccessError);
    expect(await f.countBySubject('planted')).toBe(0);
  });

  it('refuses to turn a stored draft into a sent row', async () => {
    const id = await f.seedDraft(f.ownedId);
    await expect(
      f.as(f.principal(f.drafter), async () => {
        const draft = await f.load(id);
        draft.sendStatus = 'sent';
        draft.isDraft = false;
        await draft.save();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
    expect((await f.load(id)).sendStatus).toBe('draft');
  });

  it('refuses to move a sent row onto an owned account', async () => {
    const id = await f.as(f.principal(f.stranger), async () => {
      const email = await newSent(f.openId, 'moved');
      await email.save();
      return email.id as string;
    });
    await expect(
      f.as(f.principal(f.stranger), async () => {
        const email = await f.load(id);
        email.accountId = f.ownedId;
        await email.save();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
    expect((await f.load(id)).accountId).toBe(f.openId);
  });

  it('lets a sender, the owner and trusted code record a sent row', async () => {
    for (const [label, who] of [
      ['sender', f.principal(f.sender)],
      ['owner', f.principal(f.owner)],
    ] as const) {
      await f.as(who, async () => (await newSent(f.ownedId, label)).save());
      expect(await f.countBySubject(label)).toBe(1);
    }
    await withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () =>
        (await newSent(f.ownedId, 'synced')).save(),
      ),
    );
    expect(await f.countBySubject('synced')).toBe(1);
  });

  it('leaves an unowned account open', async () => {
    await f.as(f.principal(f.stranger), async () =>
      (await newSent(f.openId, 'open')).save(),
    );
    expect(await f.countBySubject('open')).toBe(1);
  });

  it('still lets the send path create and finish a sent row', async () => {
    const draft = await f.as(f.principal(f.sender), async () => {
      const email = new Email({
        ...f.options,
        tenantId: f.tenantId,
        accountId: f.ownedId,
        subject: 'via send',
        fromAddress: 'owned@example.com',
        toAddresses: JSON.stringify([{ address: 'to@example.com' }]),
        sendStatus: 'draft',
        isDraft: true,
      });
      await email.initialize();
      return email.send();
    });
    expect(draft.success).toBe(true);
    expect(await f.countBySubject('via send')).toBe(1);
  });

  it('leaves the stored sent row alone for read flags', async () => {
    const id = await withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const email = await newSent(f.ownedId, 'record');
        await email.save();
        return email.id as string;
      }),
    );
    await f.grant(f.stranger.id, 'read');
    await f.grant(f.stranger.id, 'triage');
    await f.as(f.principal(f.stranger), async () => {
      const email = await f.load(id);
      email.isRead = true;
      await email.save();
    });
    expect((await f.load(id)).isRead).toBe(true);
  });
});

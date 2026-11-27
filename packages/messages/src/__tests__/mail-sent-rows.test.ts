/**
 * A stored `sent` row is a record that replies and forwards quote (#5696):
 * outside system access only its triage fields change under `triage`; any
 * other change, a move off or onto an owned account, and a delete need
 * `send` on the accounts involved.
 */

import { withTenant } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { MailAccessError, runWithMailSystemAccess } from '../access.js';
import { Attachment } from '../models/Attachment';
import { Email } from '../models/Email';
import { useMailDraftScopeFixture } from './helpers/mail-draft-scope-fixture.js';

describe('stored sent rows (#5696)', () => {
  const f = useMailDraftScopeFixture();

  async function seedSent(accountId: string, subject = 'record') {
    return withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const email = new Email({
          ...f.options,
          tenantId: f.tenantId,
          accountId,
          subject,
          body: 'original',
          toAddresses: JSON.stringify([{ address: 'to@example.com' }]),
          sendStatus: 'sent',
          isDraft: false,
        });
        await email.initialize();
        await email.save();
        return email.id as string;
      }),
    );
  }

  const reader = async () => {
    await f.grant(f.stranger.id, 'read');
    return f.principal(f.stranger);
  };
  const triager = async () => {
    await f.grant(f.stranger.id, 'read');
    await f.grant(f.stranger.id, 'triage');
    return f.principal(f.stranger);
  };

  it('refuses a body and recipient rewrite without send', async () => {
    const id = await seedSent(f.ownedId);
    for (const who of [await reader(), f.principal(f.drafter)]) {
      await expect(
        f.as(who, async () => {
          const email = await f.load(id);
          email.body = 'planted';
          email.toAddresses = JSON.stringify([{ address: 'x@example.com' }]);
          await email.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
    }
    const stored = await f.load(id);
    expect(stored.body).toBe('original');
  });

  it('refuses a triage grantee changing content or moving the row', async () => {
    const id = await seedSent(f.ownedId);
    const who = await triager();
    await expect(
      f.as(who, async () => {
        const email = await f.load(id);
        email.isRead = true;
        email.subject = 'planted';
        await email.save();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
    await expect(
      f.as(who, async () => {
        const email = await f.load(id);
        email.accountId = f.openId;
        await email.save();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
    const stored = await f.load(id);
    expect(stored.accountId).toBe(f.ownedId);
    expect(stored.subject).toBe('record');
  });

  it('lets triage change only the read and flag state', async () => {
    const id = await seedSent(f.ownedId);
    await f.as(await triager(), async () => {
      const email = await f.load(id);
      email.isRead = true;
      email.isFlagged = true;
      await email.save();
    });
    expect((await f.load(id)).isFlagged).toBe(true);
  });

  it('refuses read-only read flags on a sent row', async () => {
    const id = await seedSent(f.ownedId);
    await expect(
      f.as(await reader(), async () => {
        const email = await f.load(id);
        email.isRead = true;
        await email.save();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
  });

  it('needs send to move a sent row off an owned account, and to delete one', async () => {
    const id = await seedSent(f.ownedId);
    await expect(
      f.as(f.principal(f.drafter), async () => (await f.load(id)).delete()),
    ).rejects.toBeInstanceOf(MailAccessError);
    expect(await f.exists(id)).toBe(true);
    await f.as(f.principal(f.sender), async () => {
      const email = await f.load(id);
      email.accountId = f.ownedId;
      email.subject = 'amended';
      await email.save();
    });
    expect((await f.load(id)).subject).toBe('amended');
    await f.as(f.principal(f.sender), async () => (await f.load(id)).delete());
    expect(await f.exists(id)).toBe(false);
  });

  it('needs send to add or remove an attachment of sent mail', async () => {
    const id = await seedSent(f.ownedId);
    const make = async () => {
      const attachment = new Attachment({
        ...f.options,
        tenantId: f.tenantId,
        messageId: id,
        filename: 'planted.txt',
      });
      await attachment.initialize();
      return attachment;
    };
    await expect(
      f.as(await reader(), async () => (await make()).save()),
    ).rejects.toBeInstanceOf(MailAccessError);
    const saved = await f.as(f.principal(f.sender), async () => {
      const attachment = await make();
      await attachment.save();
      return attachment.id as string;
    });
    await expect(
      f.as(await reader(), async () => {
        const attachment = new Attachment({ ...f.options, id: saved });
        await attachment.initialize();
        await attachment.delete();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
  });

  it('leaves unowned accounts and trusted code alone', async () => {
    const open = await seedSent(f.openId, 'open');
    await f.as(f.principal(f.stranger), async () => {
      const email = await f.load(open);
      email.body = 'edited';
      await email.save();
    });
    expect((await f.load(open)).body).toBe('edited');
    const owned = await seedSent(f.ownedId, 'owned');
    await withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const email = await f.load(owned);
        email.body = 'synced';
        await email.save();
        await email.delete();
      }),
    );
    expect(await f.exists(owned)).toBe(false);
  });

  it('still records the send path finishing a send', async () => {
    const id = await f.seedDraft(f.ownedId);
    const result = await f.as(f.principal(f.sender), async () =>
      (await f.load(id)).send(),
    );
    expect(result.success).toBe(true);
    expect((await f.load(id)).sendStatus).toBe('sent');
  });
});

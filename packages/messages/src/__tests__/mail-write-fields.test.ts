/**
 * The stored-row comparison behind the triage-only and send-path allowances
 * covers every persisted field of the class (#5681): meta fields kept in
 * `_meta_data` and write-through fields have no column of their own.
 */

import { meta, smrt } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { MailAccessError, runWithMailSystemAccess } from '../access.js';
import { Email } from '../models/Email';
import type { EmailAccount } from '../models/EmailAccount';
import { useMailDraftScopeFixture } from './helpers/mail-draft-scope-fixture.js';

@smrt({ tableStrategy: 'sti' })
class MetaEmail extends Email {
  @meta()
  hostNote = '';
}

@smrt({
  tableStrategy: 'sti',
  writeThrough: { accountId: { fields: ['name'] } },
})
class LinkedEmail extends Email {}

describe('stored-row comparison covers meta and write-through fields (#5681)', () => {
  const f = useMailDraftScopeFixture();

  async function seed(
    Klass: typeof MetaEmail | typeof LinkedEmail,
    extra: Record<string, unknown> = {},
  ) {
    return withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const email = new Klass({
          ...f.options,
          tenantId: f.tenantId,
          accountId: f.ownedId,
          subject: 'seeded',
          isDraft: true,
          sendStatus: 'draft',
          fromAddress: 'owned@example.com',
          ...extra,
        });
        await email.initialize();
        await email.save();
        return email.id as string;
      }),
    );
  }

  async function open<T extends typeof MetaEmail | typeof LinkedEmail>(
    Klass: T,
    id: string,
  ) {
    return withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const email = new Klass({ ...f.options, id });
        await email.initialize();
        return email as InstanceType<T>;
      }),
    );
  }

  const triager = async () => {
    await f.grant(f.stranger.id, 'read');
    await f.grant(f.stranger.id, 'triage');
    return f.principal(f.stranger);
  };

  it('lets a triage-only save change the read flag of a subclass row', async () => {
    const id = await seed(MetaEmail, { hostNote: 'a' });
    const who = await triager();
    await f.as(who, async () => {
      const email = await open(MetaEmail, id);
      email.isRead = true;
      await email.save();
    });
    expect((await open(MetaEmail, id)).isRead).toBe(true);
  });

  it('refuses a meta field changed under a triage-only save', async () => {
    const id = await seed(MetaEmail, { hostNote: 'a' });
    const who = await triager();
    await expect(
      f.as(who, async () => {
        const email = await open(MetaEmail, id);
        email.isRead = true;
        email.hostNote = 'changed';
        await email.save();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
    const stored = await open(MetaEmail, id);
    expect(stored.hostNote).toBe('a');
    expect(stored.isRead).toBe(false);
  });

  it('refuses a write-through field changed under a triage-only save', async () => {
    const id = await seed(LinkedEmail);
    const who = await triager();
    await expect(
      f.as(who, async () => {
        const email = await open(LinkedEmail, id);
        email.isRead = true;
        (email as unknown as { name: string }).name = 'renamed';
        await email.save();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
    const account = await withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const { EmailAccountCollection } = await import(
          '../collections/EmailAccountCollection.js'
        );
        return (await EmailAccountCollection.create(f.options)).get({
          id: f.ownedId,
        }) as Promise<EmailAccount>;
      }),
    );
    expect(account.name).toBe('owned');
  });

  it('refuses a meta field carried by a failed send without the draft scope', async () => {
    const id = await seed(MetaEmail, { hostNote: 'a' });
    await withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const { EmailAccountCollection } = await import(
          '../collections/EmailAccountCollection.js'
        );
        const account = await (
          await EmailAccountCollection.create(f.options)
        ).get({ id: f.ownedId });
        if (!account) throw new Error('no account');
        account.isActive = false;
        await account.save();
      }),
    );
    const result = await f
      .as(f.principal(f.sender), async () => {
        const email = await open(MetaEmail, id);
        email.hostNote = 'changed';
        return email.send();
      })
      .catch((error) => error);
    expect(result).toBeInstanceOf(MailAccessError);
    expect((await open(MetaEmail, id)).hostNote).toBe('a');
  });

  it('refuses a write-through field carried by a failed send without the draft scope', async () => {
    const id = await seed(LinkedEmail);
    await withTenant({ tenantId: f.tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const { EmailAccountCollection } = await import(
          '../collections/EmailAccountCollection.js'
        );
        const account = await (
          await EmailAccountCollection.create(f.options)
        ).get({ id: f.ownedId });
        if (!account) throw new Error('no account');
        account.isActive = false;
        await account.save();
      }),
    );
    const result = await f
      .as(f.principal(f.sender), async () => {
        const email = await open(LinkedEmail, id);
        (email as unknown as { name: string }).name = 'renamed';
        return email.send();
      })
      .catch((error) => error);
    expect(result).toBeInstanceOf(MailAccessError);
  });
});

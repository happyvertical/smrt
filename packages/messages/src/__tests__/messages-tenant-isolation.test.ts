/**
 * Regression tests for the STI tenant-scoping leak (#1596) in messages.
 *
 * `@TenantScoped` registers ONLY the exact class it decorates and does NOT
 * propagate to STI subclasses. Email / EmailAccount / EmailAttachment never
 * re-declare it, while their bases (Message / Account / Attachment) all do —
 * so before the framework fix the interceptor treated the child collections'
 * `_itemClass` as non-tenant-scoped: `list()`/`get()` skipped the tenant filter
 * (cross-tenant reads), `beforeSave` skipped tenant population, and raw
 * `query()` skipped the policy. Cross-tenant data exposure.
 *
 * Part A (smrt-tenancy) now recognizes STI descendants of a tenant-scoped base
 * automatically. Turning recognition on makes the collections'
 * `findGlobal()` / `findWithGlobals()` raw/`tenantId: null` helpers throw under
 * an active tenant context, so Part B (this package) routes them through raw SQL
 * with `{ allowRawOnTenantScoped: true }`, the STI `_meta_type` scope where the
 * collection's item is an STI child, and a fail-closed guard on
 * `findWithGlobals`. Mirrors `packages/images/src/__tests__/images-tenant-isolation.test.ts`.
 *
 * Every test runs with tenancy enabled under the default `'throw'` policy and
 * asserts each leaking collection (a) does not throw and (b) returns ONLY the
 * current tenant's rows plus globals — never another tenant's rows and never a
 * sibling STI type. Real in-memory SQLite, no DB mocking, per
 * `.claude/rules/testing.md`.
 *
 * EmailAttachmentCollection note
 * ------------------------------
 * `EmailAttachmentCollection` received the identical Part B fix, but is not
 * directly exercised here: its `_itemClass` is the deprecated `EmailAttachment`
 * alias, which has no `@smrt()` decorator and so is not registered by the vitest
 * manifest loader (it IS registered when consuming the built package, where the
 * leak is real). Its `findGlobal` / `findWithGlobals` are thin wrappers over the
 * exact same `tenant-global-queries` helper as the CTI `AttachmentCollection`
 * (covered below), so the underlying code path is verified.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountCollection,
  AttachmentCollection,
  EmailAccountCollection,
  EmailCollection,
  EmailFolderCollection,
  MessageCollection,
} from '../index.js';
// Importing the models registers their schemas so getTestDatabase() creates the
// messages / accounts / attachments / email_folders tables.
import { Account } from '../models/Account';
import { Attachment } from '../models/Attachment';
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { EmailFolder } from '../models/EmailFolder';
import { Message } from '../models/Message';

const names = (
  rows: Array<{ subject?: string; name?: string; filename?: string }>,
) => rows.map((r) => r.subject ?? r.name ?? r.filename ?? '').sort();

// ===========================================================================
// EmailCollection (STI child of Message — shares the `messages` table)
// ===========================================================================

describe('EmailCollection tenant isolation (#1596)', () => {
  let db: DatabaseInterface;
  let emails: EmailCollection;
  let messages: MessageCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    emails = await EmailCollection.create({ db });
    messages = await MessageCollection.create({ db });
    enableTenancy(); // default rawQueryPolicy: 'throw'
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  /**
   * Two tenants' emails + a global email, plus sibling non-Email base Messages
   * in the SAME table (tenant-scoped and global) so a missing `_meta_type`
   * scope would surface them.
   */
  async function seed() {
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await emails.create({
          accountId: 'a1',
          messageId: '<t1a@x>',
          subject: 't1-a',
        })
      ).save();
      await (
        await emails.create({
          accountId: 'a1',
          messageId: '<t1b@x>',
          subject: 't1-b',
        })
      ).save();
      // Sibling base Message (not an Email) under the same tenant.
      await (
        await messages.create({ accountId: 'a1', subject: 't1-msg' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await emails.create({
          accountId: 'a2',
          messageId: '<t2a@x>',
          subject: 't2-a',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await emails.create({
          accountId: 'ag',
          messageId: '<g@x>',
          subject: 'g-email',
        })
      ).save();
      await (
        await messages.create({ accountId: 'ag', subject: 'g-msg' })
      ).save();
    });
  }

  it('list() returns only the current tenant Emails (no cross-tenant leak, no sibling types)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      emails.list({}),
    );
    // tenant-1's two emails only — never tenant-2's, never the global, and never
    // the base Message rows that share the table.
    expect(names(result)).toEqual(['t1-a', 't1-b']);
    expect(result.every((e) => e instanceof Email)).toBe(true);
  });

  it('findGlobal() returns only global Emails under an active tenant (no throw, no siblings)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      emails.findGlobal(),
    );
    expect(names(result)).toEqual(['g-email']);
    expect(result.every((e) => e instanceof Email)).toBe(true);
  });

  it('findWithGlobals() returns tenant Emails plus globals, scoped to Email (no throw)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      emails.findWithGlobals('tenant-1'),
    );
    expect(names(result)).toEqual(['g-email', 't1-a', 't1-b']);
    expect(result.every((e) => e instanceof Email)).toBe(true);
  });

  it('findWithGlobals() fails closed for a tenant other than the active context', async () => {
    await seed();
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        emails.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
  });

  it('findWithGlobals() still serves an arbitrary tenant under system context (admin path)', async () => {
    await seed();
    const result = await withSystemContext(() =>
      emails.findWithGlobals('tenant-2'),
    );
    expect(names(result)).toEqual(['g-email', 't2-a']);
    expect(result.every((e) => e instanceof Email)).toBe(true);
  });
});

// ===========================================================================
// EmailAccountCollection (STI child of Account — shares the `accounts` table)
// ===========================================================================

describe('EmailAccountCollection tenant isolation (#1596)', () => {
  let db: DatabaseInterface;
  let accounts: EmailAccountCollection;
  let baseAccounts: AccountCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    accounts = await EmailAccountCollection.create({ db });
    baseAccounts = await AccountCollection.create({ db });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function seed() {
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await accounts.create({
          name: 't1-a',
          email: 't1a@x',
          providerType: 'imap',
        })
      ).save();
      await (
        await accounts.create({
          name: 't1-b',
          email: 't1b@x',
          providerType: 'imap',
        })
      ).save();
      // Sibling base Account (not an EmailAccount) under the same tenant.
      await (
        await baseAccounts.create({ name: 't1-acct', providerType: 'imap' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await accounts.create({
          name: 't2-a',
          email: 't2a@x',
          providerType: 'imap',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await accounts.create({
          name: 'g-a',
          email: 'g@x',
          providerType: 'imap',
        })
      ).save();
      await (
        await baseAccounts.create({ name: 'g-acct', providerType: 'imap' })
      ).save();
    });
  }

  it('list() returns only the current tenant EmailAccounts (no leak, no sibling types)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      accounts.list({}),
    );
    expect(names(result)).toEqual(['t1-a', 't1-b']);
    expect(result.every((a) => a instanceof EmailAccount)).toBe(true);
  });

  it('findGlobal() returns only global EmailAccounts (no throw, no siblings)', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      accounts.findGlobal(),
    );
    expect(names(result)).toEqual(['g-a']);
    expect(result.every((a) => a instanceof EmailAccount)).toBe(true);
  });

  it('findWithGlobals() returns tenant EmailAccounts plus globals, scoped to EmailAccount', async () => {
    await seed();
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      accounts.findWithGlobals('tenant-1'),
    );
    expect(names(result)).toEqual(['g-a', 't1-a', 't1-b']);
    expect(result.every((a) => a instanceof EmailAccount)).toBe(true);
  });

  it('findWithGlobals() fails closed for a tenant other than the active context', async () => {
    await seed();
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        accounts.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
  });
});

// ===========================================================================
// Base / CTI collections — directly @TenantScoped, so findGlobal/findWithGlobals
// already throw under an active context on main (pre-existing, same hazard).
// AttachmentCollection (CTI) exercises the same helper path as the deprecated
// EmailAttachmentCollection (see file header).
// ===========================================================================

describe('Base messages collections tenant isolation (#1596)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('MessageCollection.findGlobal/findWithGlobals do not throw and return all subtypes for the tenant + globals', async () => {
    const messages = await MessageCollection.create({ db });
    const emails = await EmailCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await messages.create({ accountId: 'a1', subject: 't1-msg' })
      ).save();
      await (
        await emails.create({
          accountId: 'a1',
          messageId: '<t1@x>',
          subject: 't1-email',
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await messages.create({ accountId: 'a2', subject: 't2-msg' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await messages.create({ accountId: 'ag', subject: 'g-msg' })
      ).save();
    });

    const globals = await withTenant({ tenantId: 'tenant-1' }, () =>
      messages.findGlobal(),
    );
    expect(names(globals)).toEqual(['g-msg']);

    const withGlobals = await withTenant({ tenantId: 'tenant-1' }, () =>
      messages.findWithGlobals('tenant-1'),
    );
    // The STI base returns ALL message subtypes (Message + Email) for the
    // tenant plus globals — but never tenant-2's row.
    expect(names(withGlobals)).toEqual(['g-msg', 't1-email', 't1-msg']);

    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        messages.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
  });

  it('AccountCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const accounts = await AccountCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await accounts.create({ name: 't1-acct', providerType: 'imap' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await accounts.create({ name: 't2-acct', providerType: 'imap' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await accounts.create({ name: 'g-acct', providerType: 'imap' })
      ).save();
    });

    expect(
      names(
        await withTenant({ tenantId: 'tenant-1' }, () => accounts.findGlobal()),
      ),
    ).toEqual(['g-acct']);
    expect(
      names(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          accounts.findWithGlobals('tenant-1'),
        ),
      ),
    ).toEqual(['g-acct', 't1-acct']);
  });

  it('AttachmentCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const attachments = await AttachmentCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await attachments.create({ messageId: 'm1', filename: 't1-att' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await attachments.create({ messageId: 'm2', filename: 't2-att' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await attachments.create({ messageId: 'mg', filename: 'g-att' })
      ).save();
    });

    expect(
      names(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          attachments.findGlobal(),
        ),
      ),
    ).toEqual(['g-att']);
    expect(
      names(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          attachments.findWithGlobals('tenant-1'),
        ),
      ),
    ).toEqual(['g-att', 't1-att']);
  });

  it('EmailFolderCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const folders = await EmailFolderCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await folders.create({ name: 't1-folder', accountId: 'a1' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await folders.create({ name: 't2-folder', accountId: 'a2' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await folders.create({ name: 'g-folder', accountId: 'ag' })
      ).save();
    });

    expect(
      names(
        await withTenant({ tenantId: 'tenant-1' }, () => folders.findGlobal()),
      ),
    ).toEqual(['g-folder']);
    expect(
      names(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          folders.findWithGlobals('tenant-1'),
        ),
      ),
    ).toEqual(['g-folder', 't1-folder']);
  });
});

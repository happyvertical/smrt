// The cloud profile (#5191): one deployment, many owners, each with their own
// app. Threats from the issue: one owner reaching another's definition,
// history, approvals or drafts; the desktop's owner-link route reachable in the
// cloud profile; a session carried from one tenant to another.
//
// WHAT THIS PROVES: the shell's own code and models, on the real tenancy
// interceptor, over one SQLite database, with two tenants in it. WHAT IT DOES
// NOT: PostgreSQL (dialect, `database-rls` row-level-security policies: the
// shell tables are not RLS-enforced in this slice), the deployed runtime's
// startup and its PostgreSQL version probe, a live OIDC provider. Isolation
// here is APPLICATION-level: tenant context plus tenant-pinned stores.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SessionService, TenantCollection } from '@happyvertical/smrt-users';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../../test/engine-principal.ts';
import { App } from '../objects/App.ts';
import { Approval } from '../objects/Approval.ts';
import { AppVersionCollection } from '../objects/AppVersion.ts';
import { AccountError, derivedId, ownerTenantFor } from './accounts.ts';
import { applyOwnBatch, decideApproval } from './approvals.ts';
import { assistantEngine } from './assistant/engine.ts';
import { requestRecordDelete } from './builder.ts';
import {
  addChangeCard,
  changesState,
  discardChanges,
  flushChecks,
  removeChangeCard,
  waitingCount,
} from './changes.ts';
import { cloudSignInOptions } from './cloud-auth.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { subscribe } from './events.ts';
import {
  getDraftSlot,
  getHost,
  getShellDb,
  hostFor,
  tenantAppDirs,
} from './host.ts';
import { isOwner, type Principal, requireOwner, runAs } from './owner.ts';
import { ShellVersionStore } from './version-store.ts';

let h: CloudHarness;
beforeAll(async () => {
  h = await openCloudShell();
});
afterAll(async () => {
  await h.close();
});

/** The owner's Apply click on what waits, after the exact checks have run. */
async function applyWaiting(owner: Principal) {
  await runAs(owner, () => changesState());
  await flushChecks();
  const state = await runAs(owner, () => changesState());
  return runAs(owner, () => applyOwnBatch(state.digest));
}

const names = (d: { models: Record<string, unknown> }) =>
  Object.keys(d.models).sort();

describe('two owners in one deployment', () => {
  it('each builds and uses an app and cannot see the other one', async () => {
    await runAs(h.a, () =>
      App.defineModel('Chore', { title: { type: 'text' } }),
    );
    await runAs(h.b, () =>
      App.defineModel('Invoice', { number: { type: 'text' } }),
    );
    // Structure waits for each owner's own Apply; it never reaches live alone.
    expect(names(await runAs(h.a, () => App.describe()))).toEqual([]);
    await applyWaiting(h.a);
    await applyWaiting(h.b);
    await runAs(h.a, async () =>
      (await getHost()).create(hostOwner(await getHost()), 'Chore', {
        title: 'ann-secret',
      }),
    );
    await runAs(h.b, async () =>
      (await getHost()).create(hostOwner(await getHost()), 'Invoice', {
        number: 'bob-0001',
      }),
    );

    expect(names(await runAs(h.a, () => App.describe()))).toEqual(['Chore']);
    expect(names(await runAs(h.b, () => App.describe()))).toEqual(['Invoice']);
    const aRows = await runAs(h.a, async () =>
      (await getHost()).list(hostOwner(await getHost()), 'Chore'),
    );
    expect(aRows.map((r) => r.title)).toEqual(['ann-secret']);
    // The other owner's model does not exist in this app: no read, no write.
    await expect(
      runAs(h.b, async () =>
        (await getHost()).list(hostOwner(await getHost()), 'Chore'),
      ),
    ).rejects.toThrow();
    await expect(
      runAs(h.b, async () =>
        (await getHost()).create(hostOwner(await getHost()), 'Chore', {
          title: 'planted',
        }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await runAs(h.b, async () =>
          (await getHost()).list(hostOwner(await getHost()), 'Invoice'),
        )
      ).map((r) => r.number),
    ).toEqual(['bob-0001']);
  });

  it('keeps each app in its own directory under the configured root', async () => {
    const dirs: string[] = [];
    for (const owner of [h.a, h.b]) {
      const app = await runAs(owner, async () => {
        const host = await getHost();
        return host.dataDir;
      });
      dirs.push(app);
      expect(app.startsWith(join(h.dir, 'tenants', owner.tenantId))).toBe(true);
      expect(existsSync(join(app, 'app.db'))).toBe(true);
    }
    expect(dirs[0]).not.toBe(dirs[1]);
    // The desktop's single directory does not exist in the cloud profile.
    expect(existsSync(join(h.dir, 'user-app'))).toBe(false);
    expect(readdirSync(join(h.dir, 'tenants')).sort()).toEqual(
      [h.a.tenantId, h.b.tenantId].sort(),
    );
  });

  it('keeps definition history apart, by listing and by id', async () => {
    const a = await runAs(h.a, () => App.history());
    const b = await runAs(h.b, () => App.history());
    expect(JSON.stringify(a)).toContain('Chore');
    expect(JSON.stringify(a)).not.toContain('Invoice');
    expect(JSON.stringify(b)).toContain('Invoice');
    expect(JSON.stringify(b)).not.toContain('Chore');
    // Another tenant's version row is not found even by its id.
    const idsA = await runAs(h.a, async () =>
      (await (await AppVersionCollection.create({ db: h.db })).list({})).map(
        (r) => r.id as string,
      ),
    );
    expect(idsA.length).toBeGreaterThan(0);
    for (const id of idsA)
      expect(
        await runAs(h.b, async () =>
          (await AppVersionCollection.create({ db: h.db })).get(id),
        ),
      ).toBeNull();
    expect(
      await runAs(h.b, async () =>
        (await AppVersionCollection.create({ db: h.db })).list({}),
      ),
    ).toHaveLength((await runAs(h.b, () => App.history())).length);
  });

  it('keeps approvals apart: not listed, not decided, not run', async () => {
    const record = await runAs(h.a, async () =>
      (await getHost()).create(hostOwner(await getHost()), 'Chore', {
        title: 'to-delete',
      }),
    );
    const pending = (await runAs(h.a, () =>
      requestRecordDelete('Chore', record.id as string, h.a.id, 'live'),
    )) as { status: string; approvalId: string };
    expect(pending.status).toBe('pending_approval');
    expect(await runAs(h.b, () => Approval.pending())).toEqual([]);
    expect(
      (await runAs(h.a, () => Approval.pending())).map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual([pending.approvalId]);
    // B names A's approval id: refused, and A's model is untouched.
    await expect(
      runAs(h.b, () => decideApproval(pending.approvalId, true, h.b.id)),
    ).rejects.toThrow();
    expect(
      await runAs(h.a, async () =>
        (await getHost()).get(
          hostOwner(await getHost()),
          'Chore',
          record.id as string,
        ),
      ),
    ).toBeTruthy();
    // The raw conditional UPDATE names the tenant too.
    const { shellApprovalAuthority } = await import('./approval-store.ts');
    const { authority } = await runAs(h.b, () => shellApprovalAuthority());
    await expect(
      authority.decide(h.b, pending.approvalId, true),
    ).rejects.toThrow();
    expect(
      (await runAs(h.a, () => Approval.pending())).map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual([pending.approvalId]);
    // The owner of the approval decides it.
    await runAs(h.a, () => decideApproval(pending.approvalId, false, h.a.id));
  });

  it('keeps changes waiting apart: batches, cards, freeze, check and apply', async () => {
    // Anything left waiting by an earlier case is gone first.
    for (const owner of [h.a, h.b])
      if ((await runAs(owner, () => waitingCount())) > 0)
        await runAs(owner, () => discardChanges());
    const aCard = await runAs(h.a, () =>
      addChangeCard({
        commands: [
          { type: 'defineModel', name: 'AnnOnly', fields: {} } as never,
        ],
        source: 'api',
      }),
    );
    expect(await runAs(h.a, () => waitingCount())).toBe(1);
    expect(await runAs(h.b, () => waitingCount())).toBe(0);
    expect((await runAs(h.b, () => changesState())).batchId).toBeNull();
    // A's batch and cards are rows only A's tenant can read, even by id.
    const aState = await runAs(h.a, () => changesState());
    const { ChangeBatchCollection } = await import('../objects/ChangeBatch.ts');
    const { ChangeCardCollection } = await import('../objects/ChangeCard.ts');
    expect(
      await runAs(h.b, async () =>
        (await ChangeBatchCollection.create({ db: h.db })).get(
          aState.batchId as string,
        ),
      ),
    ).toBeNull();
    expect(
      await runAs(h.b, async () =>
        (await ChangeCardCollection.create({ db: h.db })).get(aCard.cardId),
      ),
    ).toBeNull();
    const seen = (owner: Principal) =>
      runAs(owner, async () =>
        (await (await ChangeCardCollection.create({ db: h.db })).list({})).map(
          (c) => c.id as string,
        ),
      );
    expect(await seen(h.b)).not.toContain(aCard.cardId);
    expect(await seen(h.a)).toContain(aCard.cardId);
    // B names A's card id, or A's reviewed digest: refused; A's card stays.
    await expect(
      runAs(h.b, () => removeChangeCard(aCard.cardId)),
    ).rejects.toThrow();
    await expect(
      runAs(h.b, () => applyOwnBatch(aState.digest || 'x')),
    ).rejects.toThrow();
    // A's waiting changes freeze A's live structure; B's is untouched.
    await expect(
      runAs(h.a, async () =>
        (await getHost()).execute(
          { type: 'defineModel', name: 'Direct', fields: {} },
          { author: h.a.id, approved: true },
        ),
      ),
    ).rejects.toThrow(/frozen|waiting|draft/i);
    await runAs(h.b, () =>
      App.defineModel('Receipt', { note: { type: 'text' } }),
    );
    // The working copies are separate directories, one per tenant.
    const aDir = (await runAs(h.a, () => getDraftSlot()))?.dir;
    const bDir = (await runAs(h.b, () => getDraftSlot()))?.dir;
    expect(aDir).toContain(h.a.tenantId);
    expect(bDir).toContain(h.b.tenantId);
    expect(aDir).not.toBe(bDir);
    // B applies its own batch: A's waiting card and A's app are untouched.
    await applyWaiting(h.b);
    expect(names(await runAs(h.b, () => App.describe()))).toContain('Receipt');
    expect(names(await runAs(h.a, () => App.describe()))).not.toContain(
      'Receipt',
    );
    expect(await runAs(h.a, () => waitingCount())).toBe(1);
    // A applies: only A's app gets the model.
    const before = JSON.stringify(await runAs(h.b, () => App.history()));
    await applyWaiting(h.a);
    expect(names(await runAs(h.a, () => App.describe()))).toContain('AnnOnly');
    expect(names(await runAs(h.b, () => App.describe()))).not.toContain(
      'AnnOnly',
    );
    expect(JSON.stringify(await runAs(h.b, () => App.history()))).toBe(before);
    expect(await runAs(h.a, () => getDraftSlot())).toBeNull();
  });

  it('delivers changes events to their own tenant only, and queues per tenant', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const offA = subscribe((e) => seenA.push(e.type), h.a.tenantId);
    const offB = subscribe((e) => seenB.push(e.type), h.b.tenantId);
    try {
      await runAs(h.a, () =>
        addChangeCard({
          commands: [{ type: 'defineModel', name: 'Ev', fields: {} } as never],
          source: 'api',
        }),
      );
      expect(seenA).toContain('changes');
      expect(seenB).toEqual([]);
    } finally {
      offA();
      offB();
      await runAs(h.a, () => discardChanges());
    }
  });

  it('delivers an owner only their own live events', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const offA = subscribe((e) => seenA.push(e.type), h.a.tenantId);
    const offB = subscribe((e) => seenB.push(e.type), h.b.tenantId);
    try {
      await runAs(h.a, async () =>
        (await getHost()).create(hostOwner(await getHost()), 'Chore', {
          title: 'event',
        }),
      );
      expect(seenA).toContain('records');
      expect(seenB).toEqual([]);
    } finally {
      offA();
      offB();
    }
  });
});

describe('the shell fails closed without a tenant', () => {
  it('hands out neither the database nor an app to a request with no tenant', async () => {
    await expect(getShellDb()).rejects.toMatchObject({ status: 401 });
    await expect(getHost()).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a tenant-pinned store used from another tenant', async () => {
    const storeA = new ShellVersionStore(h.db, h.a.tenantId);
    await expect(runAs(h.b, () => storeA.list())).rejects.toThrow(
      /another tenant/,
    );
    // From no context at all it enters its own tenant and sees only its rows.
    expect((await storeA.list()).length).toBeGreaterThan(0);
    const storeB = new ShellVersionStore(h.db, h.b.tenantId);
    const mine = JSON.stringify(await storeA.list());
    expect(mine).toContain('Chore');
    expect(mine).not.toContain('Invoice');
    expect(JSON.stringify(await storeB.list())).not.toContain('Chore');
  });

  it('builds app directories from validated ids only', () => {
    expect(() => tenantAppDirs(h.dir, '../escape', h.a.tenantId)).toThrow();
    expect(() => tenantAppDirs(h.dir, h.a.tenantId, 'a/../../x')).toThrow();
    expect(() => tenantAppDirs(h.dir, h.a.tenantId, '')).toThrow();
  });

  it('owner is the tenant owner only: a stranger, another tenant, a forged tenant', async () => {
    expect(await isOwner(h.a)).toBe(true);
    // A claiming B's tenant is not B's owner.
    expect(await isOwner({ id: h.a.id, tenantId: h.b.tenantId })).toBe(false);
    await expect(
      requireOwner({ id: h.a.id, tenantId: h.b.tenantId }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await isOwner({ id: 'nobody', tenantId: h.a.tenantId })).toBe(false);
  });
});

describe('accounts and sessions', () => {
  it('a first sign-in creates one tenant with the account as its owner; later sign-ins reuse it', async () => {
    const user = await h.newUser('cy@example.test');
    const [first, second] = await Promise.all([
      ownerTenantFor(h.db, { id: user.id, name: 'Cy' }),
      ownerTenantFor(h.db, { id: user.id, name: 'Cy' }),
    ]);
    expect(first).toBe(second);
    expect(await ownerTenantFor(h.db, { id: user.id })).toBe(first);
    expect(first).not.toBe(h.a.tenantId);
    expect(first).not.toBe(h.b.tenantId);
    expect(await isOwner({ id: user.id, tenantId: first })).toBe(true);
    const tenants = await (await TenantCollection.create({ db: h.db })).list({
      limit: 100,
    });
    expect(tenants.filter((t) => t.id === first)).toHaveLength(1);
  });

  it('never overwrites a tenant that already holds the account slug', async () => {
    const user = await h.newUser('dee@example.test');
    const tenants = await TenantCollection.create({ db: h.db });
    const squatter = await tenants.create({
      name: 'Squatter',
      slug: `ws-${derivedId(user.id, 'shell-tenant')}`,
    });
    await squatter.save();
    await expect(ownerTenantFor(h.db, { id: user.id })).rejects.toBeInstanceOf(
      AccountError,
    );
    const after = await (await TenantCollection.create({ db: h.db })).get(
      squatter.id as string,
    );
    expect(after?.name).toBe('Squatter');
  });

  it('sign-in picks the tenant from the verified account, never from the request', async () => {
    const options = await cloudSignInOptions();
    const resolve = options.tenantId as (
      result: unknown,
      event: unknown,
    ) => Promise<string>;
    // A request carrying Ann's session cookie, signing Bob in.
    const aSession = await (
      await SessionService.create({ db: h.db })
    ).createSession(h.a.id, h.a.tenantId, { authMethod: 'oidc' });
    const event = {
      cookies: { get: () => aSession },
      url: new URL(`https://${h.a.tenantId}.example.test/auth/x/callback`),
    };
    expect(await resolve({ user: { id: h.b.id }, claims: {} }, event)).toBe(
      h.b.tenantId,
    );
  });

  it('a session cannot be moved to a tenant its account does not belong to', async () => {
    const service = await SessionService.create({ db: h.db });
    const sid = await service.createSession(h.a.id, h.a.tenantId, {
      authMethod: 'oidc',
    });
    const moved = await service.switchTenant(sid, h.b.tenantId);
    expect(moved.switched).toBe(false);
    expect(moved.sessionId).toBeNull();
    const context = await service.loadSessionContext(sid);
    expect(context?.tenantId).toBe(h.a.tenantId);
  });
});

describe('what the cloud profile does not have', () => {
  it('uses only the API key engine, whatever was stored', async () => {
    expect(await assistantEngine(h.a)).toBe('api');
  });
});

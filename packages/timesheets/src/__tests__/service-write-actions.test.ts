/**
 * #4001: the service-backed time entry actions on the generated REST route.
 *
 * `record`, `submit` and `approve` are hosted on ServiceTimeEntryCollection,
 * delegate to ServiceEvidenceService, and authorize the ambient principal
 * themselves (`<collection>.<action>`), so the runtime REST transport — whose
 * auth middleware only sees the HTTP verb — cannot become an unguarded write.
 * Generated CRUD writes stay refused on every surface, MCP and CLI stay
 * read-only (#4004 adds per-operation MCP authorization).
 */
import {
  getTestDatabase,
  isApiActionEnabledForObject,
  MCPGenerator,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators';
import {
  getTenantId,
  type TenantContextData,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CommercialSnapshot,
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
  ServiceTimeEntryCollection,
  setServiceTimeEntryCommercialResolver,
} from '../index.js';

const TENANT_A = '0f9a4a2e-5b55-4f55-8d6a-1a1a1a1a1a1a';
const TENANT_B = '7c1d2e3f-4a5b-4c6d-8e7f-2b2b2b2b2b2b';
const WORKER = { userId: 'user-worker', profileId: 'profile-worker' };
const APPROVER = { userId: 'user-approver', profileId: 'profile-approver' };
const ENTRY_KEY = '@happyvertical/smrt-timesheets:ServiceTimeEntry';
const P = (action: string) => `servicetimeentries.${action}`;
const WORK = { workRefType: '@fixture/builder:WorkPackage', workRefId: 'wp-7' };

const resolver = {
  priceClient: async (): Promise<CommercialSnapshot> => ({
    amount: 12000,
    version: 'pricing-v1',
    strategy: 'hourly',
    terms: { hourlyRate: 12000 },
  }),
  compensateProvider: async (): Promise<CommercialSnapshot> => ({
    amount: 8000,
    version: 'terms-v1',
    terms: { hourlyRate: 8000 },
  }),
};

function principal(
  who: { userId: string; profileId: string },
  permissions: string[],
  tenantId = TENANT_A,
): TenantContextData {
  return {
    tenantId,
    userId: who.userId,
    user: { id: who.userId, profileId: who.profileId },
    permissions: new Set(permissions),
  };
}

describe('service-backed time entry actions (#4001)', () => {
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const api = new APIGenerator(
      {
        basePath: '/api',
        // Host authentication passes; authorization is the action's job.
        authMiddleware: () => async (req: Request) => req,
      },
      { db },
    );
    const entries = await ServiceTimeEntryCollection.create({ db });
    api.registerCollection('servicetimeentries', entries);
    handler = api.generateHandler();
    setServiceTimeEntryCommercialResolver(resolver);
  });

  afterEach(async () => {
    setServiceTimeEntryCommercialResolver(null);
    await db.close?.();
  });

  const call = (
    context: TenantContextData,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    withTenant(context, async () => {
      const response = await handler(
        new Request(`http://localhost/api/servicetimeentries${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    });

  const worker = (permissions = [P('record'), P('submit'), P('read')]) =>
    principal(WORKER, permissions);
  const approver = (permissions = [P('approve'), P('read')]) =>
    principal(APPROVER, permissions);

  async function recordOne(): Promise<string> {
    const recorded = await call(worker(), 'POST', '/record', {
      ...WORK,
      source: 'timer',
      description: 'Framed the north wall',
      startedAt: '2026-07-01T08:00:00Z',
      endedAt: '2026-07-01T10:30:00Z',
    });
    expect(recorded.status).toBe(200);
    return recorded.body.result.id as string;
  }

  it('records, submits and approves through ServiceEvidenceService', async () => {
    const recorded = await call(worker(), 'POST', '/record', {
      ...WORK,
      source: 'timer',
      startedAt: '2026-07-01T08:00:00Z',
      endedAt: '2026-07-01T10:30:00Z',
      // Caller-supplied identity, tenant and status are never honoured.
      tenantId: TENANT_B,
      status: 'approved',
      participantKind: 'agent',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body).toMatchObject({
      action: 'record',
      result: {
        status: 'draft',
        tenantId: TENANT_A,
        participantKind: 'human',
        participantProfileId: WORKER.profileId,
        durationSeconds: 9000,
      },
    });
    const id = recorded.body.result.id as string;

    const submitted = await call(worker(), 'POST', '/submit', { entryId: id });
    expect(submitted.status).toBe(200);
    expect(submitted.body.result).toMatchObject({
      status: 'submitted',
      submittedByProfileId: WORKER.profileId,
    });
    expect(submitted.body.result.submittedAt).toBeTruthy();

    const approved = await call(approver(), 'POST', '/approve', {
      entryId: id,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.result).toMatchObject({
      status: 'approved',
      approvedByProfileId: APPROVER.profileId,
      approvalPath: 'operator',
    });
    expect(approved.body.result.approvedAt).toBeTruthy();

    await withTenant({ tenantId: TENANT_A }, async () => {
      const charges = await ServiceChargeSnapshotCollection.create({ db });
      const pay = await ServiceCompensationSnapshotCollection.create({ db });
      expect(await charges.list({ where: { timeEntryId: id } })).toEqual([
        expect.objectContaining({
          amount: 12000,
          tenantId: TENANT_A,
          pricingVersion: 'pricing-v1',
        }),
      ]);
      expect(await pay.list({ where: { timeEntryId: id } })).toEqual([
        expect.objectContaining({ amount: 8000, termsVersion: 'terms-v1' }),
      ]);
    });

    // Retrying a complete approval is a no-op, not a second snapshot.
    const retried = await call(approver(), 'POST', '/approve', { entryId: id });
    expect(retried.status).toBe(200);
  });

  it('refuses each action without its permission', async () => {
    expect(
      (await call(worker([P('submit')]), 'POST', '/record', WORK)).status,
    ).toBe(403);
    const id = await recordOne();
    expect(
      (await call(worker([P('record')]), 'POST', '/submit', { entryId: id }))
        .status,
    ).toBe(403);
    expect(
      (await call(worker(), 'POST', '/submit', { entryId: id })).status,
    ).toBe(200);
    // The worker cannot approve their own (or anyone's) time without the grant.
    const selfApproval = await call(worker(), 'POST', '/approve', {
      entryId: id,
    });
    expect(selfApproval.status).toBe(403);
    expect(selfApproval.body.error).toMatchObject({
      code: 'permission_denied',
    });
  });

  it('fails closed without an authenticated tenant principal', async () => {
    const response = await handler(
      new Request('http://localhost/api/servicetimeentries/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(WORK),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('does not let super-admin bypass stand in for an approve grant', async () => {
    const id = await recordOne();
    await call(worker(), 'POST', '/submit', { entryId: id });
    const bypass = await call(
      { ...principal(APPROVER, [P('read')]), superAdminBypass: true },
      'POST',
      '/approve',
      { entryId: id },
    );
    expect(bypass.status).toBe(403);
  });

  it('only lets the participant submit, unless the caller can approve', async () => {
    const id = await recordOne();
    const other = principal(
      { userId: 'user-other', profileId: 'profile-other' },
      [P('record'), P('submit')],
    );
    expect((await call(other, 'POST', '/submit', { entryId: id })).status).toBe(
      403,
    );
    expect(
      (
        await call(other, 'POST', '/record', {
          ...WORK,
          durationSeconds: 600,
          participantProfileId: WORKER.profileId,
        })
      ).status,
    ).toBe(403);
    const supervisor = principal(APPROVER, [P('submit'), P('approve')]);
    expect(
      (await call(supervisor, 'POST', '/submit', { entryId: id })).body.result,
    ).toMatchObject({
      status: 'submitted',
      submittedByProfileId: APPROVER.profileId,
    });
  });

  it("cannot reach another tenant's entry", async () => {
    const id = await recordOne();
    const foreign = principal(WORKER, [P('submit'), P('approve')], TENANT_B);
    expect(
      (await call(foreign, 'POST', '/submit', { entryId: id })).status,
    ).toBe(404);
  });

  it('builds a factory resolver per request on the collection executor', async () => {
    const seen: Array<{ db: unknown; tenantId: string | undefined }> = [];
    setServiceTimeEntryCommercialResolver(({ options }) => {
      seen.push({ db: options.db, tenantId: getTenantId() ?? undefined });
      return resolver;
    });
    const id = await recordOne();
    await call(worker(), 'POST', '/submit', { entryId: id });
    const approved = await call(approver(), 'POST', '/approve', {
      entryId: id,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.result).toMatchObject({ status: 'approved' });
    expect(seen).toEqual([{ db, tenantId: TENANT_A }]);
  });

  it('refuses approval with no installed commercial resolver, writing nothing', async () => {
    const id = await recordOne();
    await call(worker(), 'POST', '/submit', { entryId: id });
    setServiceTimeEntryCommercialResolver(null);
    const refused = await call(approver(), 'POST', '/approve', { entryId: id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'approval_not_configured',
    });
    await withTenant({ tenantId: TENANT_A }, async () => {
      const entries = await ServiceTimeEntryCollection.create({ db });
      expect((await entries.get({ id }))?.status).toBe('submitted');
      const charges = await ServiceChargeSnapshotCollection.create({ db });
      expect(await charges.list({ where: { timeEntryId: id } })).toEqual([]);
    });
  });

  it('reports service preconditions as 400, not 500', async () => {
    const id = await recordOne();
    const early = await call(approver(), 'POST', '/approve', { entryId: id });
    expect(early.status).toBe(400);
    expect(
      (await call(worker(), 'POST', '/record', { workRefType: 'x' })).status,
    ).toBe(400);
  });

  it('keeps generated CRUD writes refused on REST', async () => {
    const id = await recordOne();
    const create = await call(
      worker([P('record'), P('create'), P('update')]),
      'POST',
      '',
      { ...WORK, participantKind: 'human', status: 'approved' },
    );
    expect(create.status).toBe(405);
    const update = await call(worker([P('update')]), 'PATCH', `/${id}`, {
      status: 'approved',
    });
    expect(update.status).toBe(405);
    for (const action of ['create', 'update', 'delete'] as const) {
      expect(isApiActionEnabledForObject(ENTRY_KEY, action)).toBe(false);
    }
  });

  it('publishes no generated write tool on MCP and no CLI surface on the collection', async () => {
    const tools = (await new MCPGenerator().generateTools())
      .map((tool) => tool.name)
      .filter((name) => /^(servicetimeentry|service\w+snapshot)/.test(name));
    expect(tools.length).toBeGreaterThan(0);
    for (const name of tools) {
      expect(name).toMatch(/_(get|list|forwork|pendingapproval)$/);
    }
    expect(
      ObjectRegistry.getConfig(
        '@happyvertical/smrt-timesheets:ServiceTimeEntryCollection',
      ).cli,
    ).toBe(false);
  });
});

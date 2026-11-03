import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BookingAuthority,
  type BookingContext,
  type BookingKind,
  type BookingReferences,
  BookingService,
  migrateBookingsV1,
} from './index.js';

const url = process.env.SMRT_TEST_POSTGRES_URL;
const window = {
  zone: 'UTC',
  start: '2027-01-01T09:00+00:00',
  end: '2027-01-01T10:00+00:00',
};
const terms = {
  revision: 'r1',
  text: 'One explicitly agreed coverage window.',
};

function gate() {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe.skipIf(!url)('Bookings on PostgreSQL', () => {
  let admin: DatabaseInterface | undefined;
  let dbA: DatabaseInterface;
  let dbB: DatabaseInterface;
  let databaseName: string | undefined;

  beforeAll(async () => {
    const dbUrl = new URL(String(url));
    if (!process.env.CI_POSTGRES_MANAGED) {
      // Standalone calls use their own disposable database as well.
      admin = await getDatabase({ type: 'postgres', url, cache: false });
      databaseName = `smrt_bookings_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      dbUrl.pathname = `/${databaseName}`;
    }
    const second = new URL(dbUrl);
    dbUrl.searchParams.set('application_name', 'smrt-bookings-a');
    second.searchParams.set('application_name', 'smrt-bookings-b');
    dbA = await getDatabase({
      type: 'postgres',
      url: String(dbUrl),
      cache: false,
    });
    dbB = await getDatabase({
      type: 'postgres',
      url: String(second),
      cache: false,
    });
    const first = (await dbA.query('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid;
    const next = (await dbB.query('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid;
    expect(first).not.toBe(next);
    await migrateBookingsV1(dbA);
  });

  afterAll(async () => {
    await Promise.all([dbA?.close?.(), dbB?.close?.()]);
    try {
      if (databaseName)
        await admin?.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    } finally {
      await admin?.close?.();
    }
  });

  async function waitOnLock(fragment: string) {
    await expect
      .poll(async () => {
        const { rows } = await dbA.query(
          `SELECT pid FROM pg_stat_activity
         WHERE application_name = 'smrt-bookings-b' AND wait_event_type = 'Lock'
           AND query LIKE ?`,
          `%${fragment}%`,
        );
        return rows.length;
      })
      .toBe(1);
  }

  async function world(capacity = 2) {
    const tenantId = randomUUID();
    const providerId = randomUUID();
    const otherProviderId = randomUUID();
    const customerId = randomUUID();
    const projects = new Set<string>();
    const operatorContext = { tenantId, actorId: 'operator' };
    const requester = { tenantId, actorId: 'requester' };
    const outsider = { tenantId, actorId: 'outsider' };
    const plan = { id: randomUUID(), version: 'approved-v1' };
    const rights = {
      operator: true,
      approve: true,
      beforeVerify: async (_refs: BookingReferences) => {},
    };
    const authority: BookingAuthority = {
      async access(ctx, _operation) {
        if (ctx.actorId === 'operator') return { operator: rights.operator };
        return {
          operator: false,
          contactId: ctx.actorId === 'requester' ? customerId : undefined,
        };
      },
      async verifyReferences(ctx, refs) {
        await rights.beforeVerify(refs);
        return (
          ctx.tenantId === tenantId &&
          (!refs.contactId || refs.contactId === customerId) &&
          (!refs.projectId || projects.has(refs.projectId)) &&
          (!refs.providerId ||
            refs.providerId === providerId ||
            refs.providerId === otherProviderId) &&
          (!refs.approvedPlan ||
            (rights.approve &&
              refs.approvedPlan.id === plan.id &&
              refs.approvedPlan.version === plan.version))
        );
      },
    };
    const a = new BookingService(dbA, authority);
    const b = new BookingService(dbB, authority);
    const offering = {
      'developer-hour': randomUUID(),
      'supervision-day': randomUUID(),
    };
    for (const kind of ['developer-hour', 'supervision-day'] as const) {
      await a.configureOffering(operatorContext, randomUUID(), {
        offeringId: offering[kind],
        kind,
        enabled: true,
      });
    }
    const availability = (provider = providerId, units = capacity) => ({
      providerId: provider,
      zone: window.zone,
      windows: [
        {
          start: window.start,
          end: window.end,
          capacity: units,
          supervision: true,
        },
        {
          start: window.end,
          end: '2027-01-01T11:00+00:00',
          capacity: units,
          supervision: false,
        },
      ],
    });
    await a.declareAvailability(operatorContext, randomUUID(), availability());
    await a.declareAvailability(
      operatorContext,
      randomUUID(),
      availability(otherProviderId),
    );

    async function request(
      kind: BookingKind = 'supervision-day',
      projectId?: string,
    ) {
      if (kind === 'supervision-day') {
        projectId ??= randomUUID();
        projects.add(projectId);
      }
      const result = await a.request(requester, randomUUID(), {
        offeringId: offering[kind],
        contactId: customerId,
        projectId,
      });
      return result.id;
    }

    async function propose(
      bookingId: string,
      kind: BookingKind = 'supervision-day',
      provider = providerId,
      chosenWindow = window,
    ) {
      const result = await a.propose(operatorContext, randomUUID(), {
        bookingId,
        providerId: provider,
        window: chosenWindow,
        terms,
        approvedPlan: kind === 'supervision-day' ? plan : undefined,
      });
      if (!result.proposalId) throw new Error('Expected a proposal');
      return { bookingId, proposalId: result.proposalId };
    }

    async function prepare(
      kind: BookingKind = 'supervision-day',
      options: {
        projectId?: string;
        provider?: string;
        window?: typeof window;
      } = {},
    ) {
      const result = await propose(
        await request(kind, options.projectId),
        kind,
        options.provider,
        options.window,
      );
      await a.assent(requester, randomUUID(), result);
      return result;
    }

    return {
      a,
      b,
      tenantId,
      providerId,
      otherProviderId,
      customerId,
      operatorContext,
      requester,
      outsider,
      rights,
      offering,
      plan,
      availability,
      request,
      propose,
      prepare,
    };
  }

  it('serializes cap plus one, retries after release, and rejects capacity reductions', async () => {
    const w = await world();
    const first = await w.prepare();
    const second = await w.prepare();
    const extra = await w.prepare();
    await w.a.confirm(w.operatorContext, randomUUID(), first);
    const entered = gate();
    const proceed = gate();
    let waiting = true;
    w.rights.beforeVerify = async (refs) => {
      if (!refs.approvedPlan || !waiting) return;
      waiting = false;
      entered.open();
      await proceed.wait;
    };
    const confirmSecond = w.a.confirm(w.operatorContext, randomUUID(), second);
    await entered.wait;
    const extraKey = randomUUID();
    const extraOutcome = w.b
      .confirm(w.operatorContext, extraKey, extra)
      .catch((error) => error);
    try {
      await waitOnLock('smrt_booking_resources');
    } finally {
      proceed.open();
      await confirmSecond;
    }
    expect(await extraOutcome).toMatchObject({ code: 'unavailable' });
    expect(await w.a.get(w.requester, extra.bookingId)).toMatchObject({
      status: 'proposed',
    });
    await expect(
      w.a.declareAvailability(
        w.operatorContext,
        randomUUID(),
        w.availability(w.providerId, 1),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await w.a.cancel(w.operatorContext, randomUUID(), {
      bookingId: first.bookingId,
      reason: 'Fixture cancellation',
    });
    await expect(
      w.b.confirm(w.operatorContext, extraKey, extra),
    ).resolves.toMatchObject({ id: extra.bookingId });
  });

  it.each([
    'developer-hour',
    'supervision-day',
  ] as const)('blocks exclusive overlap when %s is confirmed first and permits touching endpoints', async (firstKind) => {
    const w = await world();
    const otherKind =
      firstKind === 'developer-hour' ? 'supervision-day' : 'developer-hour';
    const first = await w.prepare(firstKind);
    const second = await w.prepare(otherKind);
    await w.a.confirm(w.operatorContext, randomUUID(), first);
    await expect(
      w.b.confirm(w.operatorContext, randomUUID(), second),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const touching = await w.prepare('developer-hour', {
      window: { ...window, start: window.end, end: '2027-01-01T11:00+00:00' },
    });
    await expect(
      w.b.confirm(w.operatorContext, randomUUID(), touching),
    ).resolves.toMatchObject({ id: touching.bookingId });
  });

  it('uses a database uniqueness constraint across providers for the same project and exact window', async () => {
    const w = await world();
    const projectId = randomUUID();
    const first = await w.prepare('supervision-day', { projectId });
    const second = await w.prepare('supervision-day', {
      projectId,
      provider: w.otherProviderId,
    });
    const outcomes = await Promise.allSettled([
      w.a.confirm(w.operatorContext, randomUUID(), first),
      w.b.confirm(w.operatorContext, randomUUID(), second),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'duplicate-project-window' } });
  });

  it('serializes confirm and cancel on the same booking and releases exactly once', async () => {
    const w = await world(1);
    const target = await w.prepare();
    const next = await w.prepare();
    const entered = gate();
    const proceed = gate();
    w.rights.beforeVerify = async ({ approvedPlan }) => {
      if (approvedPlan) {
        entered.open();
        await proceed.wait;
      }
    };
    const confirming = w.a.confirm(w.operatorContext, randomUUID(), target);
    await entered.wait;
    const cancelKey = randomUUID();
    const cancellation = {
      bookingId: target.bookingId,
      reason: 'Cancelled after approval',
    };
    const cancelling = w.b
      .cancel(w.operatorContext, cancelKey, cancellation)
      .catch((error) => error);
    try {
      await waitOnLock('FROM smrt_bookings');
    } finally {
      proceed.open();
      await confirming;
    }
    expect(await cancelling).toMatchObject({ id: target.bookingId });
    expect(
      await w.a.cancel(w.operatorContext, cancelKey, cancellation),
    ).toEqual(await cancelling);
    expect(await w.a.get(w.requester, target.bookingId)).toMatchObject({
      status: 'cancelled',
      confirmedProposalId: target.proposalId,
    });
    await expect(
      w.a.confirm(w.operatorContext, randomUUID(), next),
    ).resolves.toMatchObject({ id: next.bookingId });
    expect(
      (await w.a.history(w.operatorContext, target.bookingId)).map(
        (event) => event.operation,
      ),
    ).toEqual(['request', 'propose', 'assent', 'confirm', 'cancel']);
  });

  it('binds replay to canonical content and current authority across distinct connections', async () => {
    const w = await world();
    const payload = {
      contactId: w.customerId,
      offeringId: w.offering['developer-hour'],
    };
    const key = randomUUID();
    const [one, two] = await Promise.all([
      w.a.request(w.requester, key, payload),
      w.b.request(w.requester, key, {
        offeringId: payload.offeringId.toUpperCase(),
        contactId: payload.contactId,
      }),
    ]);
    expect(one).toEqual(two);
    await expect(
      w.b.request(w.requester, key, {
        ...payload,
        offeringId: w.offering['supervision-day'],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      w.b.request(w.operatorContext, key, payload),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(w.b.request(w.outsider, key, payload)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await w.a.history(w.operatorContext, one.id)).toHaveLength(1);
    const availabilityKey = randomUUID();
    const available = w.availability();
    await w.a.declareAvailability(
      w.operatorContext,
      availabilityKey,
      available,
    );
    expect(
      await w.b.declareAvailability(w.operatorContext, availabilityKey, {
        ...available,
        windows: [...available.windows].reverse(),
      }),
    ).toEqual({ id: w.providerId });
  });

  it('requires the exact current assent and approved plan, preserves agreed wording, and scopes reads and writes', async () => {
    const w = await world();
    const first = await w.prepare();
    const revisedTerms = {
      revision: 'r2',
      text: 'Revised exact service terms.',
    };
    const revised = await w.a.propose(w.operatorContext, randomUUID(), {
      bookingId: first.bookingId,
      providerId: w.providerId,
      window,
      terms: revisedTerms,
      approvedPlan: w.plan,
    });
    if (!revised.proposalId) throw new Error('Expected a proposal');
    const latest = {
      bookingId: first.bookingId,
      proposalId: revised.proposalId,
    };
    expect(
      await w.a.getProposal(w.requester, first.bookingId, first.proposalId),
    ).toMatchObject({ terms });
    await expect(
      w.a.getProposal(w.outsider, first.bookingId, first.proposalId),
    ).rejects.toMatchObject({ code: 'not-found' });
    const denied = (ctx: BookingContext) => w.a.get(ctx, first.bookingId);
    await expect(denied(w.outsider)).rejects.toMatchObject({
      code: 'not-found',
    });
    const foreign = { ...w.operatorContext, tenantId: randomUUID() };
    await expect(denied(foreign)).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      w.a.confirm(foreign, randomUUID(), latest),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      w.a.propose(w.operatorContext, randomUUID(), {
        bookingId: first.bookingId,
        providerId: randomUUID(),
        window,
        terms,
        approvedPlan: w.plan,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      w.a.request(w.requester, randomUUID(), {
        offeringId: w.offering['supervision-day'],
        contactId: w.customerId,
        projectId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      w.a.assent(w.operatorContext, randomUUID(), latest),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      w.a.confirm(w.requester, randomUUID(), latest),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      w.a.confirm(w.operatorContext, randomUUID(), first),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      w.a.assent(w.requester, randomUUID(), first),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      w.a.confirm(w.operatorContext, randomUUID(), latest),
    ).rejects.toMatchObject({ code: 'conflict' });
    await w.a.assent(w.requester, randomUUID(), latest);
    w.rights.approve = false;
    const confirmKey = randomUUID();
    await expect(
      w.b.confirm(w.operatorContext, confirmKey, latest),
    ).rejects.toMatchObject({ code: 'forbidden' });
    w.rights.approve = true;
    await w.b.confirm(w.operatorContext, confirmKey, latest);
    w.rights.operator = false;
    await expect(
      w.b.confirm(w.operatorContext, confirmKey, latest),
    ).rejects.toMatchObject({ code: 'forbidden' });
    w.rights.operator = true;
    await expect(w.propose(first.bookingId)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await w.a.get(w.requester, first.bookingId)).toMatchObject({
      status: 'confirmed',
      proposal: {
        id: latest.proposalId,
        terms: revisedTerms,
        approvedPlan: w.plan,
        window,
      },
      assentedProposalId: latest.proposalId,
      confirmedProposalId: latest.proposalId,
    });
    expect(await w.a.history(w.operatorContext, first.bookingId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'assent',
          actorId: 'requester',
          proposalId: latest.proposalId,
        }),
      ]),
    );
    const declined = await w.request();
    await w.a.decline(w.operatorContext, randomUUID(), {
      bookingId: declined,
      reason: 'Cannot meet requested terms',
    });
    expect(await w.a.get(w.requester, declined)).toMatchObject({
      status: 'declined',
    });
  });

  it('rolls back an allocation when its final audit write fails, leaving the same key retryable', async () => {
    const w = await world(1);
    const first = await w.prepare();
    const key = randomUUID();
    // Force a real PostgreSQL failure after the allocation and status write.
    await dbA.query(`CREATE FUNCTION smrt_test_abort_confirm() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation = 'confirm' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END
      $$`);
    await dbA.query(`CREATE TRIGGER smrt_test_abort_confirm BEFORE UPDATE ON smrt_booking_commands
      FOR EACH ROW EXECUTE FUNCTION smrt_test_abort_confirm()`);
    try {
      await expect(
        w.a.confirm(w.operatorContext, key, first),
      ).rejects.toThrow();
      expect(await w.a.get(w.requester, first.bookingId)).toMatchObject({
        status: 'proposed',
      });
      expect(
        (
          await dbA.query(
            'SELECT booking_id FROM smrt_booking_allocations WHERE tenant_id = ?',
            w.tenantId,
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (await w.a.history(w.operatorContext, first.bookingId)).map(
          (event) => event.operation,
        ),
      ).toEqual(['request', 'propose', 'assent']);
    } finally {
      await dbA.query(
        'DROP TRIGGER smrt_test_abort_confirm ON smrt_booking_commands',
      );
      await dbA.query('DROP FUNCTION smrt_test_abort_confirm()');
    }
    await expect(
      w.b.confirm(w.operatorContext, key, first),
    ).resolves.toMatchObject({ id: first.bookingId });
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BookingAuthority,
  type BookingContext,
  type BookingKind,
  type BookingReferences,
  BookingService,
  migrateBookingsV1,
  migrateBookingsV2,
  resolveBookingWindow,
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
  let baseUrl: URL;

  beforeAll(async () => {
    const dbUrl = new URL(String(url));
    if (!process.env.CI_POSTGRES_MANAGED) {
      // Standalone calls use their own disposable database as well.
      admin = await getDatabase({ type: 'postgres', url, cache: false });
      databaseName = `smrt_bookings_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      dbUrl.pathname = `/${databaseName}`;
    }
    baseUrl = new URL(dbUrl);
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
    await migrateBookingsV2(dbA);
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

  const toronto = (date: string, from = '09:00', to = '17:00') => ({
    zone: 'America/Toronto',
    start: `${date}T${from}-05:00`,
    end: `${date}T${to}-05:00`,
  });

  async function torontoWorld(dates = ['2027-03-01', '2027-03-02']) {
    const w = await world();
    await w.a.declareAvailability(w.operatorContext, randomUUID(), {
      providerId: w.otherProviderId,
      zone: 'America/Toronto',
      windows: dates.map((date) => ({
        start: `${date}T09:00-05:00`,
        end: `${date}T17:00-05:00`,
        capacity: 1,
        supervision: false,
      })),
    });
    const dayOffering = randomUUID();
    await w.a.configureOffering(w.operatorContext, randomUUID(), {
      offeringId: dayOffering,
      kind: 'developer-hour',
      unit: 'day',
      priceCents: 150000,
      currency: 'CAD',
      enabled: true,
    });
    return { ...w, dayOffering };
  }

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
    const otherCustomerId = randomUUID();
    const projects = new Set<string>();
    const operatorContext = { tenantId, actorId: 'operator' };
    const requester = { tenantId, actorId: 'requester' };
    const outsider = { tenantId, actorId: 'outsider' };
    const otherRequester = { tenantId, actorId: 'other-requester' };
    const plan = { id: randomUUID(), version: 'approved-v1' };
    const rights = {
      operator: true,
      approve: true,
      beforeVerify: async (_refs: BookingReferences) => {},
    };
    const authority: BookingAuthority = {
      async access(ctx, _operation) {
        if (ctx.actorId === 'denied') return null;
        if (ctx.actorId === 'operator') return { operator: rights.operator };
        return {
          operator: false,
          contactId:
            ctx.actorId === 'requester'
              ? customerId
              : ctx.actorId === otherRequester.actorId
                ? otherCustomerId
                : undefined,
        };
      },
      async verifyReferences(ctx, refs) {
        await rights.beforeVerify(refs);
        return (
          ctx.tenantId === tenantId &&
          (!refs.contactId ||
            refs.contactId === customerId ||
            refs.contactId === otherCustomerId) &&
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
      otherCustomerId,
      otherRequester,
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

  it('upgrades v1 rows additively and keeps their reservations working', async () => {
    const name = `smrt_bookings_${randomUUID().replaceAll('-', '')}`;
    await dbA.query(`CREATE DATABASE ${name}`);
    const target = new URL(baseUrl);
    target.pathname = `/${name}`;
    const old = await getDatabase({
      type: 'postgres',
      url: String(target),
      cache: false,
    });
    try {
      await migrateBookingsV1(old);
      const tenantId = randomUUID();
      const hourOffering = randomUUID();
      const supervisionOffering = randomUUID();
      const providerId = randomUUID();
      const customerId = randomUUID();
      const projectId = randomUUID();
      const planId = randomUUID();
      const slot = resolveBookingWindow(window);
      const declaredWindow = {
        ...resolveBookingWindow({
          zone: 'UTC',
          start: '2027-01-01T09:00+00:00',
          end: '2027-01-01T12:00+00:00',
        }),
        capacity: 1,
        supervision: false,
      };
      const q = (sql: string, ...params: unknown[]) =>
        old.query(sql, ...params);
      await q(
        `INSERT INTO smrt_booking_offerings (tenant_id, id, kind, enabled) VALUES (?, ?, 'developer-hour', true), (?, ?, 'supervision-day', true)`,
        tenantId,
        hourOffering,
        tenantId,
        supervisionOffering,
      );
      await q(
        `INSERT INTO smrt_booking_resources (tenant_id, id, windows) VALUES (?, ?, ?)`,
        tenantId,
        providerId,
        JSON.stringify([declaredWindow]),
      );
      const hourBooking = randomUUID();
      const proposalId = randomUUID();
      await q(
        `INSERT INTO smrt_bookings (tenant_id, id, offering_id, contact_id, kind, status) VALUES (?, ?, ?, ?, 'developer-hour', 'requested')`,
        tenantId,
        hourBooking,
        hourOffering,
        customerId,
      );
      await q(
        `INSERT INTO smrt_booking_proposals (tenant_id, booking_id, id, provider_id, coverage, terms, approved_plan) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        tenantId,
        hourBooking,
        proposalId,
        providerId,
        JSON.stringify(slot),
        JSON.stringify(terms),
      );
      await q(
        `UPDATE smrt_bookings SET status = 'confirmed', proposal_id = ?, assented_proposal_id = ?, confirmed_proposal_id = ? WHERE tenant_id = ? AND id = ?`,
        proposalId,
        proposalId,
        proposalId,
        tenantId,
        hourBooking,
      );
      await q(
        `INSERT INTO smrt_booking_allocations (tenant_id, booking_id, proposal_id, provider_id, project_id, exclusive, start_at, end_at) VALUES (?, ?, ?, ?, NULL, true, ?, ?)`,
        tenantId,
        hourBooking,
        proposalId,
        providerId,
        slot.startUtc,
        slot.endUtc,
      );
      const supervisionBooking = randomUUID();
      await q(
        `INSERT INTO smrt_bookings (tenant_id, id, offering_id, contact_id, project_id, kind, status) VALUES (?, ?, ?, ?, ?, 'supervision-day', 'requested')`,
        tenantId,
        supervisionBooking,
        supervisionOffering,
        customerId,
        projectId,
      );
      void planId;
      // A v1 retry key committed before the upgrade (hashes as v1 computed them).
      const sha = (value: string) =>
        createHash('sha256').update(value).digest('hex');
      const legacyKey = randomUUID();
      await q(
        `INSERT INTO smrt_booking_commands (tenant_id, operation, key_hash, actor_id, payload_hash, booking_id, result)
         VALUES (?, 'request', ?, 'requester', ?, ?, ?)`,
        tenantId,
        sha(legacyKey),
        sha(
          JSON.stringify({
            offeringId: hourOffering,
            contactId: customerId,
            projectId: null,
          }),
        ),
        hourBooking,
        JSON.stringify({ id: hourBooking }),
      );

      await migrateBookingsV2(old);

      const authority: BookingAuthority = {
        async access(ctx) {
          return ctx.actorId === 'operator'
            ? { operator: true }
            : { operator: false, contactId: customerId };
        },
        verifyReferences: async () => true,
      };
      const service = new BookingService(old, authority);
      const operatorContext = { tenantId, actorId: 'operator' };
      const requester = { tenantId, actorId: 'requester' };
      expect(
        await service.request(requester, legacyKey, {
          offeringId: hourOffering,
          contactId: customerId,
        }),
      ).toEqual({ id: hourBooking });
      const offerings = (await service.listOfferings(operatorContext)).items;
      expect(offerings).toEqual(
        expect.arrayContaining([
          {
            id: hourOffering,
            kind: 'developer-hour',
            unit: 'hour',
            priceCents: null,
            currency: null,
            title: '',
            description: '',
            public: false,
            enabled: true,
          },
          {
            id: supervisionOffering,
            kind: 'supervision-day',
            unit: 'day',
            priceCents: null,
            currency: null,
            title: '',
            description: '',
            public: false,
            enabled: true,
          },
        ]),
      );
      const upgraded = await service.get(requester, hourBooking);
      expect(upgraded).toMatchObject({
        unit: 'hour',
        quantity: 1,
        status: 'confirmed',
      });
      expect(upgraded.proposal).toMatchObject({
        unit: 'hour',
        quantity: 1,
        unitPriceCents: null,
        currency: null,
        totalCents: null,
        window: slot,
        windows: [slot],
      });
      expect(await service.get(requester, supervisionBooking)).toMatchObject({
        unit: 'day',
        quantity: 1,
      });

      // The v1 allocation still blocks, and cancelling it frees the window.
      const next = await service.request(requester, randomUUID(), {
        offeringId: hourOffering,
        contactId: customerId,
      });
      const proposed = await service.propose(operatorContext, randomUUID(), {
        bookingId: next.id,
        providerId,
        window,
        terms,
      });
      const nextRef = {
        bookingId: next.id,
        proposalId: proposed.proposalId as string,
      };
      await service.assent(requester, randomUUID(), nextRef);
      await expect(
        service.confirm(operatorContext, randomUUID(), nextRef),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await service.cancel(operatorContext, randomUUID(), {
        bookingId: hourBooking,
        reason: 'Upgrade check',
      });
      await expect(
        service.confirm(operatorContext, randomUUID(), nextRef),
      ).resolves.toMatchObject({ id: next.id });
    } finally {
      await old.close?.();
      await dbA.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  });

  it('freezes a priced multi-window proposal and reserves every segment', async () => {
    const w = await torontoWorld();
    const booking = await w.a.request(w.requester, randomUUID(), {
      offeringId: w.dayOffering,
      contactId: w.customerId,
      quantity: 2,
    });
    const windows = [toronto('2027-03-02'), toronto('2027-03-01')];
    const proposed = await w.a.propose(w.operatorContext, randomUUID(), {
      bookingId: booking.id,
      providerId: w.otherProviderId,
      windows,
      terms,
    });
    const ref = {
      bookingId: booking.id,
      proposalId: proposed.proposalId as string,
    };
    const expected = {
      unit: 'day',
      quantity: 2,
      unitPriceCents: 150000,
      currency: 'CAD',
      totalCents: 300000,
      window: {
        start: '2027-03-01T09:00-05:00',
        end: '2027-03-02T17:00-05:00',
      },
    };
    const proposal = await w.a.getProposal(
      w.requester,
      booking.id,
      ref.proposalId,
    );
    expect(proposal).toMatchObject(expected);
    expect(proposal.windows.map((entry) => entry.start)).toEqual([
      '2027-03-01T09:00-05:00',
      '2027-03-02T09:00-05:00',
    ]);
    expect(await w.a.get(w.requester, booking.id)).toMatchObject({
      unit: 'day',
      quantity: 2,
    });
    await w.a.configureOffering(w.operatorContext, randomUUID(), {
      offeringId: w.dayOffering,
      kind: 'developer-hour',
      unit: 'day',
      priceCents: 999,
      currency: 'CAD',
      enabled: true,
    });
    expect(
      await w.a.getProposal(w.requester, booking.id, ref.proposalId),
    ).toMatchObject(expected);
    expect(
      (await w.a.listOfferings(w.operatorContext)).items.find(
        (o) => o.id === w.dayOffering,
      ),
    ).toMatchObject({ unit: 'day', priceCents: 999, currency: 'CAD' });
    await w.a.assent(w.requester, randomUUID(), ref);
    await w.a.confirm(w.operatorContext, randomUUID(), ref);

    const overlapping = async (date: string) => {
      const hour = await w.a.request(w.requester, randomUUID(), {
        offeringId: w.offering['developer-hour'],
        contactId: w.customerId,
      });
      const proposal = await w.a.propose(w.operatorContext, randomUUID(), {
        bookingId: hour.id,
        providerId: w.otherProviderId,
        window: toronto(date, '10:00', '11:00'),
        terms,
      });
      const hourRef = {
        bookingId: hour.id,
        proposalId: proposal.proposalId as string,
      };
      await w.a.assent(w.requester, randomUUID(), hourRef);
      return hourRef;
    };
    const first = await overlapping('2027-03-01');
    const second = await overlapping('2027-03-02');
    for (const ref of [first, second]) {
      await expect(
        w.a.confirm(w.operatorContext, randomUUID(), ref),
      ).rejects.toMatchObject({ code: 'unavailable' });
    }
    await w.a.cancel(w.operatorContext, randomUUID(), {
      bookingId: booking.id,
      reason: 'Release both',
    });
    for (const ref of [first, second]) {
      await expect(
        w.a.confirm(w.operatorContext, randomUUID(), ref),
      ).resolves.toMatchObject({ id: ref.bookingId });
    }
  });

  it('rejects windows that do not measure the quantity and offering identity changes', async () => {
    const w = await torontoWorld();
    const day = await w.a.request(w.requester, randomUUID(), {
      offeringId: w.dayOffering,
      contactId: w.customerId,
      quantity: 2,
    });
    const propose = (bookingId: string, input: object) =>
      w.a.propose(w.operatorContext, randomUUID(), {
        bookingId,
        providerId: w.otherProviderId,
        terms,
        ...input,
      } as never);
    await expect(
      propose(day.id, { window: toronto('2027-03-01') }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      propose(day.id, {
        window: toronto('2027-03-01'),
        windows: [toronto('2027-03-01')],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(propose(day.id, {})).rejects.toMatchObject({
      code: 'invalid',
    });
    const hour = await w.a.request(w.requester, randomUUID(), {
      offeringId: w.offering['developer-hour'],
      contactId: w.customerId,
    });
    await expect(
      propose(hour.id, { window: toronto('2027-03-01', '09:00', '10:30') }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      propose(hour.id, {
        window: toronto('2027-03-01', '09:00', '10:00'),
        quantity: 2,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      propose(hour.id, { window: toronto('2027-03-01', '09:00', '10:00') }),
    ).resolves.toMatchObject({ id: hour.id });
    await expect(
      w.a.configureOffering(w.operatorContext, randomUUID(), {
        offeringId: w.dayOffering,
        kind: 'developer-hour',
        unit: 'week',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      w.a.configureOffering(w.operatorContext, randomUUID(), {
        offeringId: w.dayOffering,
        kind: 'supervision-day',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    for (const bad of [
      { kind: 'supervision-day' as const, unit: 'hour' as const },
      { kind: 'developer-hour' as const, priceCents: 5 },
      { kind: 'developer-hour' as const, priceCents: -1, currency: 'CAD' },
      { kind: 'developer-hour' as const, priceCents: 1.5, currency: 'CAD' },
      { kind: 'developer-hour' as const, priceCents: 5, currency: 'cad' },
    ]) {
      await expect(
        w.a.configureOffering(w.operatorContext, randomUUID(), {
          offeringId: randomUUID(),
          enabled: true,
          ...bad,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(
      w.a.request(w.requester, randomUUID(), {
        offeringId: w.offering['supervision-day'],
        contactId: w.customerId,
        projectId: randomUUID(),
        quantity: 2,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      w.a.request(w.requester, randomUUID(), {
        offeringId: w.dayOffering,
        contactId: w.customerId,
        quantity: 1001,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    const supervision = await w.request('supervision-day');
    await expect(
      w.a.propose(w.operatorContext, randomUUID(), {
        bookingId: supervision,
        providerId: w.providerId,
        window,
        quantity: 2,
        terms,
        approvedPlan: w.plan,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  describe('listOpenSlots', () => {
    const day = '2027-01-01';
    const range = { from: `${day}T00:00:00Z`, to: '2027-01-02T00:00:00Z' };
    const starts = (page: {
      items: Array<{ windows: Array<{ start: string }> }>;
    }) => page.items.map((slot) => slot.windows[0].start.slice(11, 16));

    it('steps hourly, honours range and quantity, and excludes occupied segments', async () => {
      const w = await world();
      // otherProviderId gets one long window so quantity 2 has room.
      await w.a.declareAvailability(w.operatorContext, randomUUID(), {
        providerId: w.otherProviderId,
        zone: 'UTC',
        windows: [
          {
            start: `${day}T09:00+00:00`,
            end: `${day}T12:00+00:00`,
            capacity: 1,
            supervision: false,
          },
        ],
      });
      const query = (extra: object = {}) =>
        w.a.listOpenSlots(w.requester, {
          offeringId: w.offering['developer-hour'],
          providerId: w.otherProviderId,
          ...range,
          ...extra,
        });
      expect(starts(await query())).toEqual(['09:00', '10:00', '11:00']);
      expect(starts(await query({ from: `${day}T09:30:00Z` }))).toEqual([
        '10:00',
        '11:00',
      ]);
      expect(starts(await query({ to: `${day}T11:00:00Z` }))).toEqual([
        '09:00',
        '10:00',
      ]);
      expect(starts(await query({ quantity: 2 }))).toEqual(['09:00', '10:00']);
      const hour = {
        zone: 'UTC',
        start: `${day}T11:00+00:00`,
        end: `${day}T12:00+00:00`,
      };
      await w.a.confirm(
        w.operatorContext,
        randomUUID(),
        await w.prepare('developer-hour', {
          provider: w.otherProviderId,
          window: hour,
        }),
      );
      expect(starts(await query())).toEqual(['09:00', '10:00']);
      expect(starts(await query({ quantity: 2 }))).toEqual(['09:00']);
      const slot = (await query({ limit: 1 })).items[0];
      expect(slot).toMatchObject({
        providerId: w.otherProviderId,
        offeringId: w.offering['developer-hour'],
        unit: 'hour',
        quantity: 1,
        remainingCapacity: 1,
      });
      expect(slot.windows[0]).toMatchObject({
        zone: 'UTC',
        start: `${day}T09:00+00:00`,
        end: `${day}T10:00+00:00`,
        startUtc: `${day}T09:00:00.000Z`,
        endUtc: `${day}T10:00:00.000Z`,
      });
      // A listed slot can be proposed as-is.
      const request = await w.a.request(w.requester, randomUUID(), {
        offeringId: w.offering['developer-hour'],
        contactId: w.customerId,
      });
      await expect(
        w.a.propose(w.operatorContext, randomUUID(), {
          bookingId: request.id,
          providerId: w.otherProviderId,
          windows: slot.windows,
          terms,
        }),
      ).resolves.toMatchObject({ id: request.id });
    });

    it('pages stably with an opaque cursor and rejects malformed ones', async () => {
      const w = await world();
      await w.a.declareAvailability(w.operatorContext, randomUUID(), {
        providerId: w.otherProviderId,
        zone: 'UTC',
        windows: [
          {
            start: `${day}T09:00+00:00`,
            end: `${day}T12:00+00:00`,
            capacity: 1,
            supervision: false,
          },
        ],
      });
      const base = { offeringId: w.offering['developer-hour'], ...range };
      const everything = await w.a.listOpenSlots(w.requester, base);
      expect(everything.items).toHaveLength(5);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const next = await w.b.listOpenSlots(w.requester, {
          ...base,
          limit: 1,
          after: cursor,
        });
        seen.push(
          ...next.items.map(
            (slot) => `${slot.windows[0].startUtc}|${slot.providerId}`,
          ),
        );
        cursor = next.nextCursor ?? undefined;
        pages++;
      } while (cursor);
      expect(pages).toBe(5);
      expect(seen).toEqual(
        everything.items.map(
          (slot) => `${slot.windows[0].startUtc}|${slot.providerId}`,
        ),
      );
      expect([...seen].sort()).toEqual(seen);
      for (const after of [
        'nope',
        `${day}T09:00:00.000Z`,
        `${day}T09:00:00Z|${w.providerId}`,
      ]) {
        await expect(
          w.a.listOpenSlots(w.requester, { ...base, after }),
        ).rejects.toMatchObject({ code: 'invalid' });
      }
    });

    it('reports supervision capacity and drops it when an exclusive hour lands inside', async () => {
      const w = await world();
      const query = (extra: object = {}) =>
        w.a.listOpenSlots(w.requester, {
          offeringId: w.offering['supervision-day'],
          ...range,
          ...extra,
        });
      const initial = await query();
      expect(
        initial.items.map((slot) => [slot.providerId, slot.remainingCapacity]),
      ).toEqual(
        [w.providerId, w.otherProviderId]
          .sort()
          .map((provider) => [provider, 2]),
      );
      await w.a.confirm(
        w.operatorContext,
        randomUUID(),
        await w.prepare('supervision-day'),
      );
      const shared = await query({ providerId: w.providerId });
      expect(shared.items.map((slot) => slot.remainingCapacity)).toEqual([1]);
      await w.a.confirm(
        w.operatorContext,
        randomUUID(),
        await w.prepare('developer-hour', { provider: w.otherProviderId }),
      );
      expect((await query({ providerId: w.otherProviderId })).items).toEqual(
        [],
      );
      // The shared supervision also hides that provider's dedicated hour.
      const hours = await w.a.listOpenSlots(w.requester, {
        offeringId: w.offering['developer-hour'],
        providerId: w.providerId,
        ...range,
      });
      expect(starts(hours)).toEqual(['10:00']);
      await expect(query({ quantity: 2 })).rejects.toMatchObject({
        code: 'invalid',
      });
    });

    it('bundles day windows, requires the full quantity of days and lists a DST fold once', async () => {
      const w = await torontoWorld();
      await w.a.declareAvailability(w.operatorContext, randomUUID(), {
        providerId: w.otherProviderId,
        zone: 'America/Toronto',
        windows: [
          {
            start: '2027-03-01T09:00-05:00',
            end: '2027-03-01T12:00-05:00',
            capacity: 1,
            supervision: false,
          },
          {
            start: '2027-03-01T13:00-05:00',
            end: '2027-03-01T17:00-05:00',
            capacity: 1,
            supervision: false,
          },
          {
            start: '2027-03-02T09:00-05:00',
            end: '2027-03-02T17:00-05:00',
            capacity: 1,
            supervision: false,
          },
        ],
      });
      const query = (quantity: number) =>
        w.a.listOpenSlots(w.requester, {
          offeringId: w.dayOffering,
          providerId: w.otherProviderId,
          from: '2027-02-28T00:00:00Z',
          to: '2027-03-10T00:00:00Z',
          quantity,
        });
      const one = await query(1);
      expect(one.items.map((slot) => slot.windows.map((s) => s.start))).toEqual(
        [
          ['2027-03-01T09:00-05:00', '2027-03-01T13:00-05:00'],
          ['2027-03-02T09:00-05:00'],
        ],
      );
      expect(one.items[0]).toMatchObject({
        unit: 'day',
        quantity: 1,
        remainingCapacity: 1,
      });
      const two = await query(2);
      expect(two.items.map((slot) => slot.windows.length)).toEqual([3]);
      // The bundle can be proposed and priced as listed.
      const booking = await w.a.request(w.requester, randomUUID(), {
        offeringId: w.dayOffering,
        contactId: w.customerId,
        quantity: 2,
      });
      await expect(
        w.a.propose(w.operatorContext, randomUUID(), {
          bookingId: booking.id,
          providerId: w.otherProviderId,
          windows: two.items[0].windows,
          terms,
        }),
      ).resolves.toMatchObject({ id: booking.id });

      // Discovery never lists a bundle that exceeds the proposal segment limit.
      const long = Array.from({ length: 201 }, (_, i) => {
        const date = new Date(Date.UTC(2027, 3, 1 + i))
          .toISOString()
          .slice(0, 10);
        return [
          {
            start: `${date}T09:00+00:00`,
            end: `${date}T12:00+00:00`,
            capacity: 1,
            supervision: false,
          },
          {
            start: `${date}T13:00+00:00`,
            end: `${date}T17:00+00:00`,
            capacity: 1,
            supervision: false,
          },
        ];
      }).flat();
      await w.a.declareAvailability(w.operatorContext, randomUUID(), {
        providerId: w.providerId,
        zone: 'UTC',
        windows: long,
      });
      const longQuery = (quantity: number) =>
        w.a.listOpenSlots(w.requester, {
          offeringId: w.dayOffering,
          providerId: w.providerId,
          from: '2027-03-31T00:00:00Z',
          to: '2027-10-20T00:00:00Z',
          quantity,
        });
      expect((await longQuery(201)).items).toEqual([]);
      expect(
        (await longQuery(200)).items.map((slot) => slot.windows.length),
      ).toEqual([400, 400]);

      await w.a.declareAvailability(w.operatorContext, randomUUID(), {
        providerId: w.providerId,
        zone: 'America/New_York',
        windows: [
          {
            start: '2027-11-07T00:30-04:00',
            end: '2027-11-07T03:00-05:00',
            capacity: 1,
            supervision: false,
          },
        ],
      });
      const fold = await w.a.listOpenSlots(w.requester, {
        offeringId: w.offering['developer-hour'],
        providerId: w.providerId,
        from: '2027-11-07T00:00:00Z',
        to: '2027-11-08T00:00:00Z',
      });
      expect(
        fold.items.map((slot) => [slot.windows[0].start, slot.windows[0].end]),
      ).toEqual([
        ['2027-11-07T00:30-04:00', '2027-11-07T01:30-04:00'],
        ['2027-11-07T01:30-04:00', '2027-11-07T01:30-05:00'],
        ['2027-11-07T01:30-05:00', '2027-11-07T02:30-05:00'],
      ]);
    });

    it('applies the three reader classes and validates the range', async () => {
      const w = await world();
      const base = { offeringId: w.offering['developer-hour'], ...range };
      // outsider has access with no contact mapping; the offering is not public.
      await expect(w.a.listOpenSlots(w.outsider, base)).rejects.toMatchObject({
        code: 'not-found',
      });
      await expect(
        w.a.listOpenSlots({ ...w.outsider, actorId: 'denied' }, base),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await w.a.configureOffering(w.operatorContext, randomUUID(), {
        offeringId: w.offering['developer-hour'],
        kind: 'developer-hour',
        public: true,
        enabled: true,
      });
      expect(
        (await w.a.listOpenSlots(w.outsider, base)).items.length,
      ).toBeGreaterThan(0);
      await w.a.configureOffering(w.operatorContext, randomUUID(), {
        offeringId: w.offering['developer-hour'],
        kind: 'developer-hour',
        public: true,
        enabled: false,
      });
      await expect(w.a.listOpenSlots(w.requester, base)).rejects.toMatchObject({
        code: 'not-found',
      });
      await expect(w.a.listOpenSlots(w.outsider, base)).rejects.toMatchObject({
        code: 'not-found',
      });
      expect(
        (await w.a.listOpenSlots(w.operatorContext, base)).items.length,
      ).toBeGreaterThan(0);
      await expect(
        w.a.listOpenSlots(w.operatorContext, {
          ...base,
          to: '2028-03-01T00:00:00Z',
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        w.a.listOpenSlots(w.operatorContext, {
          ...base,
          from: range.to,
          to: range.from,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        w.a.listOpenSlots(w.operatorContext, {
          ...base,
          offeringId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
      // Discovery is a pure read: nothing was written.
      expect(
        (
          await dbA.query(
            'SELECT 1 FROM smrt_bookings WHERE tenant_id = ?',
            w.tenantId,
          )
        ).rows,
      ).toHaveLength(0);
    });
  });

  describe('lead-bound requests', () => {
    async function lead() {
      const w = await world();
      const projects = new Set<string>();
      const seen: BookingReferences[] = [];
      const contacts: string[] = [];
      const authority: BookingAuthority = {
        async access(ctx) {
          if (ctx.actorId === 'operator') return { operator: true };
          return ctx.actorId === 'requester'
            ? { operator: false, contactId: w.customerId }
            : { operator: false };
        },
        async verifyContact(ctx, contactId) {
          contacts.push(contactId);
          return ctx.tenantId === w.tenantId && contactId === w.customerId;
        },
        async verifyReferences(_ctx, refs) {
          seen.push(refs);
          return (
            (!refs.contactId || refs.contactId === w.customerId) &&
            (!refs.projectId || projects.has(refs.projectId)) &&
            (!refs.providerId || refs.providerId === w.providerId)
          );
        },
      };
      const service = new BookingService(dbA, authority);
      const request = () =>
        service.request(w.requester, randomUUID(), {
          offeringId: w.offering['developer-hour'],
          contactId: w.customerId,
        });
      return { w, service, projects, seen, contacts, request };
    }

    it('runs a dedicated booking without a project through verifyContact only', async () => {
      const { w, service, seen, contacts, request } = await lead();
      const booking = await request();
      expect(contacts).toEqual([w.customerId]);
      const proposed = await service.propose(w.operatorContext, randomUUID(), {
        bookingId: booking.id,
        providerId: w.providerId,
        window,
        terms,
      });
      const ref = {
        bookingId: booking.id,
        proposalId: proposed.proposalId as string,
      };
      await service.assent(w.requester, randomUUID(), ref);
      await service.confirm(w.operatorContext, randomUUID(), ref);
      expect(await service.get(w.requester, booking.id)).toMatchObject({
        status: 'confirmed',
        projectId: null,
      });
      await service.cancel(w.operatorContext, randomUUID(), {
        bookingId: booking.id,
        reason: 'Lead went cold',
      });
      expect(contacts.length).toBeGreaterThanOrEqual(4);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((refs) => refs.contactId === undefined)).toBe(true);
      // An unmapped actor and an unknown contact are refused by the callback.
      await expect(
        service.request(w.operatorContext, randomUUID(), {
          offeringId: w.offering['developer-hour'],
          contactId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        service.request(w.requester, randomUUID(), {
          offeringId: w.offering['supervision-day'],
          contactId: w.customerId,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    });

    it('attaches a project once, idempotently, as an audited operator command', async () => {
      const { w, service, projects, seen, request } = await lead();
      const booking = await request();
      const projectId = randomUUID();
      const otherProject = randomUUID();
      projects.add(projectId);
      projects.add(otherProject);
      const key = randomUUID();
      const input = { bookingId: booking.id, projectId };
      await expect(
        service.attachProject(w.requester, randomUUID(), input),
      ).rejects.toMatchObject({ code: 'forbidden' });
      const receipt = await service.attachProject(
        w.operatorContext,
        key,
        input,
      );
      expect(receipt).toEqual({ id: booking.id });
      expect(seen).toContainEqual({ contactId: w.customerId, projectId });
      expect(
        await service.attachProject(w.operatorContext, key, input),
      ).toEqual(receipt);
      expect(
        await service.attachProject(w.operatorContext, randomUUID(), input),
      ).toEqual(receipt);
      const operations = (
        await service.history(w.operatorContext, booking.id)
      ).map((event) => event.operation);
      expect(
        operations.filter((operation) => operation === 'attach-project'),
      ).toHaveLength(2);
      await expect(
        service.attachProject(w.operatorContext, randomUUID(), {
          bookingId: booking.id,
          projectId: otherProject,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(
        (
          await service.listBookings(w.operatorContext, { projectId })
        ).items.map((item) => item.id),
      ).toEqual([booking.id]);
      expect(await service.get(w.requester, booking.id)).toMatchObject({
        projectId,
      });

      const closed = await request();
      await service.cancel(w.operatorContext, randomUUID(), {
        bookingId: closed.id,
        reason: 'No longer needed',
      });
      await expect(
        service.attachProject(w.operatorContext, randomUUID(), {
          bookingId: closed.id,
          projectId,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      const unverified = await request();
      await expect(
        service.attachProject(w.operatorContext, randomUUID(), {
          bookingId: unverified.id,
          projectId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  it('narrows bookings by contact for operators and only by the caller for others', async () => {
    const w = await world();
    const mine = await w.request('developer-hour');
    const theirs = await w.a.request(w.otherRequester, randomUUID(), {
      offeringId: w.offering['developer-hour'],
      contactId: w.otherCustomerId,
    });
    const ids = async (ctx: BookingContext, contactId?: string) =>
      (await w.a.listBookings(ctx, { contactId })).items.map((item) => item.id);
    expect(await ids(w.operatorContext, w.customerId)).toEqual([mine]);
    expect(await ids(w.operatorContext, w.otherCustomerId)).toEqual([
      theirs.id,
    ]);
    expect(await ids(w.requester, w.customerId)).toEqual([mine]);
    await expect(ids(w.requester, w.otherCustomerId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

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

  it('discovers only authorized bookings with stable project-filtered pages', async () => {
    const w = await world();
    const foreign = await world();
    const projectId = randomUUID();
    const proposed = await w.prepare('supervision-day', { projectId });
    const sameProject = await w.request('supervision-day', projectId);
    const unrelated = await w.request('supervision-day');
    const foreignBooking = await foreign.request('supervision-day', projectId);
    const other = await w.a.request(w.otherRequester, randomUUID(), {
      offeringId: w.offering['supervision-day'],
      contactId: w.otherCustomerId,
      projectId,
    });

    const first = await w.a.listBookings(w.requester, { projectId, limit: 1 });
    const second = await w.b.listBookings(w.requester, {
      projectId,
      limit: 1,
      afterId: first.nextCursor ?? undefined,
    });
    expect(first.nextCursor).toBe(first.items[0]?.id);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items]).toEqual(
      await Promise.all(
        [proposed.bookingId, sameProject]
          .sort()
          .map((id) => w.a.get(w.requester, id)),
      ),
    );
    expect(
      (await w.a.listBookings(w.otherRequester, { projectId })).items.map(
        ({ id }) => id,
      ),
    ).toEqual([other.id]);
    expect(
      (await w.a.listBookings(w.operatorContext, { projectId })).items.map(
        ({ id }) => id,
      ),
    ).toEqual([proposed.bookingId, sameProject, other.id].sort());
    expect(
      (await w.a.listBookings(w.operatorContext)).items.map(({ id }) => id),
    ).toEqual([proposed.bookingId, sameProject, other.id, unrelated].sort());
    expect(
      (
        await foreign.a.listBookings(foreign.operatorContext, { projectId })
      ).items.map(({ id }) => id),
    ).toEqual([foreignBooking]);
    await expect(w.a.listBookings(w.outsider)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      w.a.listBookings(w.requester, { afterId: 'invalid' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('lists only safe offering fields and restricts provider schedules to operators', async () => {
    const w = await world();
    await world();
    await w.a.configureOffering(w.operatorContext, randomUUID(), {
      offeringId: w.offering['developer-hour'],
      kind: 'developer-hour',
      enabled: false,
    });
    expect(await w.a.listOfferings(w.requester)).toEqual({
      items: [
        {
          id: w.offering['supervision-day'],
          kind: 'supervision-day',
          unit: 'day',
          priceCents: null,
          currency: null,
          title: '',
          description: '',
          public: false,
          enabled: true,
        },
      ],
      nextCursor: null,
    });
    const one = await w.a.listOfferings(w.operatorContext, { limit: 1 });
    const two = await w.a.listOfferings(w.operatorContext, {
      limit: 1,
      afterId: one.nextCursor ?? undefined,
    });
    expect([...one.items, ...two.items].map(({ id }) => id)).toEqual(
      Object.values(w.offering).sort(),
    );
    expect(two.nextCursor).toBeNull();
    // A reader with no contact mapping sees only enabled public offerings.
    expect((await w.a.listOfferings(w.outsider)).items).toEqual([]);
    await w.a.configureOffering(w.operatorContext, randomUUID(), {
      offeringId: w.offering['supervision-day'],
      kind: 'supervision-day',
      title: 'Supervision day',
      description: 'Shared supervision capacity.',
      public: true,
      enabled: true,
    });
    expect((await w.a.listOfferings(w.outsider)).items).toEqual([
      expect.objectContaining({
        id: w.offering['supervision-day'],
        title: 'Supervision day',
        description: 'Shared supervision capacity.',
        public: true,
      }),
    ]);
    await expect(
      w.a.listOfferings({ ...w.outsider, actorId: 'denied' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    for (const bad of [
      { title: 'x'.repeat(121) },
      { description: 'x'.repeat(2001) },
      { title: 'a\0b' },
    ]) {
      await expect(
        w.a.configureOffering(w.operatorContext, randomUUID(), {
          offeringId: randomUUID(),
          kind: 'developer-hour',
          enabled: true,
          ...bad,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(
      w.a.listOfferings(w.requester, { limit: 101 }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.a.listAvailability(w.requester)).rejects.toMatchObject({
      code: 'forbidden',
    });

    const schedules = await w.a.listAvailability(w.operatorContext, {
      limit: 1,
    });
    const more = await w.a.listAvailability(w.operatorContext, {
      afterId: schedules.nextCursor ?? undefined,
    });
    expect(
      [...schedules.items, ...more.items].map(({ providerId }) => providerId),
    ).toEqual([w.providerId, w.otherProviderId].sort());
    expect(schedules.items[0]?.windows[0]).toMatchObject({
      ...window,
      capacity: 2,
      supervision: true,
    });
    expect(more.nextCursor).toBeNull();
    w.rights.operator = false;
    await expect(w.a.listAvailability(w.operatorContext)).rejects.toMatchObject(
      { code: 'forbidden' },
    );
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

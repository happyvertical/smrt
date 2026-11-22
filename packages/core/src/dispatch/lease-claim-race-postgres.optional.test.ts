/**
 * Dispatch lease ownership under concurrent claimers on PostgreSQL (P6 T02,
 * optional lane).
 *
 * Every claimer is its own database handle with its own connection pool on
 * the same schema, so claims really race inside PostgreSQL. A barrier holds
 * each claimer's first claim statement of a wave until every claimer has
 * reached it, then releases them together. No sleeps synchronise anything;
 * lease expiry is set explicitly in the table.
 *
 * Guarantees checked over many rounds: each claimable row has exactly one
 * owner per claim (the token RETURNING hands back), a handler runs once per
 * attempt, only the owner's token-fenced settle writes the outcome, an
 * expired lease is reclaimed by exactly one new owner, and `attempts` grows
 * by one per claim.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  dispatchLeaseRow,
  insertRawDispatch,
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
  rowsOf,
} from '../__tests__/fixtures/dispatch-test-db';
import { createDispatchBus, type DispatchBus } from './bus.js';
import {
  claimDispatchLease,
  type DispatchLease,
  type DispatchLeaseSettings,
  settleDispatchLease,
} from './lease.js';
import type { DispatchProcessStats } from './types.js';

const SIGNAL = 'job.race';
const SUBSCRIBER = 'worker';
const PAST = '2026-01-01T00:00:00.000Z';
/** Long enough that no heartbeat renewal fires while a test runs. */
const LEASE_MS = 600_000;
const SETTINGS: DispatchLeaseSettings = { leaseMs: LEASE_MS, maxAttempts: 5 };
const MAX_CLAIMERS = 5;

const CLAIM =
  /^UPDATE _smrt_dispatch SET status = 'processing', lease_token = /;
const SETTLE =
  /^UPDATE _smrt_dispatch SET status = '(completed|failed)'.* WHERE .*lease_token = \$\d+/;

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** Resolves once every claimer arrived (or finished without claiming). */
class Barrier {
  private readonly arrived = new Set<number>();
  private open: () => void = () => {};
  readonly released: Promise<void>;
  constructor(private readonly parties: number) {
    this.released = new Promise((resolve) => {
      this.open = resolve;
    });
  }
  mark(claimer: number): void {
    this.arrived.add(claimer);
    if (this.arrived.size >= this.parties) this.open();
  }
  async arrive(claimer: number): Promise<void> {
    this.mark(claimer);
    await this.released;
  }
}

interface ClaimRecord {
  claimer: number;
  id: string;
  token: string;
  attempts: number;
}

/** What the database told each claimer, recorded from its own handle. */
interface RaceLog {
  /** Claim statements that returned the row: the claimer owns it. */
  wins: ClaimRecord[];
  /** Claim statements that returned nothing. */
  losses: { claimer: number; token: string }[];
  /** Token-fenced settles that returned the row. */
  settles: { claimer: number; id: string }[];
  /** Handler invocations. */
  handled: { claimer: number; id: string; attempts: number }[];
}

const emptyLog = (): RaceLog => ({
  wins: [],
  losses: [],
  settles: [],
  handled: [],
});

interface RaceContext {
  ctx: DispatchTestDatabase;
  handles: DatabaseInterface[];
  buses: DispatchBus[];
  log: RaceLog;
  /** Barrier for the current wave, if armed. */
  barrier: Barrier | null;
}

const groupBy = <T>(items: T[], key: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(key(item)) ?? [];
    list.push(item);
    groups.set(key(item), list);
  }
  return groups;
};

describe.skipIf(!postgresDispatchUrl)(
  'dispatch lease claim race on pg (separate connections)',
  () => {
    const contexts: RaceContext[] = [];

    afterEach(async () => {
      for (const race of contexts.splice(0)) {
        for (const handle of race.handles) await handle.close?.();
        await race.ctx.close();
      }
    });

    /** A schema of its own and {@link MAX_CLAIMERS} independent handles. */
    const openRace = async (label: string): Promise<RaceContext> => {
      const ctx = await openPostgresDispatchDatabase(label);
      const race: RaceContext = {
        ctx,
        handles: [],
        buses: [],
        log: emptyLog(),
        barrier: null,
      };
      contexts.push(race);
      await ctx.bus.subscribe({ signalType: SIGNAL, subscriber: SUBSCRIBER });
      for (let claimer = 0; claimer < MAX_CLAIMERS; claimer++) {
        const handle = (await getDatabase({
          type: 'postgres',
          url: String(ctx.url),
          max: 3,
          dbid: `smrt-test-dispatch-race-${claimer}-${randomUUID()}`,
        } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
        race.handles.push(handle);
        watch(race, handle, claimer);
        race.buses.push(
          await createDispatchBus({ db: handle, leaseMs: LEASE_MS }),
        );
      }
      return race;
    };

    /** Record claim and settle results on `handle`; gate claims on the barrier. */
    const watch = (
      race: RaceContext,
      handle: DatabaseInterface,
      claimer: number,
    ) => {
      const mutable = handle as unknown as {
        query: DatabaseInterface['query'];
      };
      const original = mutable.query;
      mutable.query = (async (sql: string, ...params: unknown[]) => {
        const text = flat(sql);
        const isClaim = CLAIM.test(text);
        if (isClaim && race.barrier) await race.barrier.arrive(claimer);
        const result = await original.call(handle, sql, ...params);
        if (isClaim) {
          const rows = rowsOf(result);
          if (rows.length === 0) {
            race.log.losses.push({ claimer, token: String(params[0]) });
          }
          for (const row of rows) {
            race.log.wins.push({
              claimer,
              id: String(row.id),
              token: String(row.lease_token),
              attempts: Number(row.attempts),
            });
          }
        } else if (SETTLE.test(text)) {
          for (const row of rowsOf(result)) {
            race.log.settles.push({ claimer, id: String(row.id) });
          }
        }
        return result;
      }) as DatabaseInterface['query'];
    };

    /** `$first, ...` placeholders for `ids`. */
    const inList = (ids: string[], first: number) =>
      ids.map((_, i) => `$${first + i}`).join(', ');

    const countClaimable = async (db: DatabaseInterface, ids: string[]) => {
      const rows = rowsOf(
        await db.query(
          `SELECT COUNT(*) AS n FROM _smrt_dispatch
            WHERE (status = 'pending'
              OR (status = 'processing' AND claimed_until < $1))
              AND id IN (${inList(ids, 2)})`,
          new Date().toISOString(),
          ...ids,
        ),
      );
      return Number(rows[0]?.n ?? 0);
    };

    /**
     * Run waves of `claimers` concurrent `process()` calls (claim batch
     * `limit`) until no row of `ids` is claimable. Each wave's first claim
     * statements are released together.
     */
    const raceProcess = async (
      race: RaceContext,
      ids: string[],
      claimers: number,
      limit: number,
    ) => {
      const stats: DispatchProcessStats[] = [];
      const waveLosses: number[] = [];
      let waves = 0;
      while ((await countClaimable(race.ctx.db, ids)) > 0) {
        waves++;
        if (waves > ids.length + 1) throw new Error('waves did not converge');
        const lossesBefore = race.log.losses.length;
        const barrier = new Barrier(claimers);
        race.barrier = barrier;
        try {
          await Promise.all(
            race.buses.slice(0, claimers).map((bus, claimer) =>
              bus
                .process(
                  SUBSCRIBER,
                  async (_payload, metadata) => {
                    race.log.handled.push({
                      claimer,
                      id: metadata.id,
                      attempts: metadata.attempts,
                    });
                  },
                  { limit, onStats: (s) => stats.push(s) },
                )
                .finally(() => barrier.mark(claimer)),
            ),
          );
        } finally {
          race.barrier = null;
        }
        waveLosses.push(race.log.losses.length - lossesBefore);
      }
      return {
        stats,
        /** Call after the ownership checks, which say more on failure. */
        expectContention() {
          // Every claimer read the same candidates before any claim was
          // released, so all of them contended for the first row of a wave.
          for (const losses of waveLosses) {
            expect(losses, 'losing claims in a wave').toBeGreaterThanOrEqual(
              claimers - 1,
            );
          }
        },
      };
    };

    /** Every row of `ids` has one owner per claim, settled by that owner. */
    const expectOneOwnerPerRow = async (
      race: RaceContext,
      ids: string[],
      attempts: number,
    ) => {
      const wins = groupBy(
        race.log.wins.filter((win) => ids.includes(win.id)),
        (win) => win.id,
      );
      const handled = groupBy(
        race.log.handled.filter((call) => ids.includes(call.id)),
        (call) => call.id,
      );
      const settles = groupBy(
        race.log.settles.filter((settle) => ids.includes(settle.id)),
        (settle) => settle.id,
      );
      for (const id of ids) {
        const owners = (wins.get(id) ?? []).map((win) => win.claimer);
        expect(owners, `owners of ${id}`).toHaveLength(1);
        const [win] = wins.get(id) ?? [];
        expect(win?.attempts, `claim attempts of ${id}`).toBe(attempts);
        expect(
          (handled.get(id) ?? []).map((call) => [call.claimer, call.attempts]),
          `handler runs of ${id}`,
        ).toEqual([[win?.claimer, attempts]]);
        expect(
          (settles.get(id) ?? []).map((settle) => settle.claimer),
          `settles of ${id}`,
        ).toEqual([win?.claimer]);
        const row = await dispatchLeaseRow(race.ctx.db, id);
        expect(row.status, `status of ${id}`).toBe('completed');
        expect(row.attempts, `attempts of ${id}`).toBe(attempts);
        expect(row.leaseToken, `token of ${id}`).toBe(win?.token);
        expect(row.claimedUntil, `expiry of ${id}`).toBeNull();
      }
    };

    const sum = (
      stats: DispatchProcessStats[],
      key: keyof DispatchProcessStats,
    ) => stats.reduce((total, s) => total + s[key], 0);

    const PROCESS_ROUNDS = [
      { claimers: 5, rows: 1, limit: 100 },
      { claimers: 4, rows: 2, limit: 100 },
      { claimers: 5, rows: 3, limit: 1 },
      { claimers: 3, rows: 12, limit: 4 },
      { claimers: 4, rows: 30, limit: 7 },
      { claimers: 2, rows: 40, limit: 100 },
    ];
    const REPEATS = 4;

    it('claims every pending row for exactly one of the concurrent process() callers', async () => {
      const race = await openRace('lease_race_pending');
      let round = 0;
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        for (const { claimers, rows, limit } of PROCESS_ROUNDS) {
          round++;
          const ids = Array.from(
            { length: rows },
            (_, i) => `p${round}-${String(i).padStart(3, '0')}`,
          );
          for (const id of ids) {
            await insertRawDispatch(race.ctx.db, { id, type: SIGNAL });
          }
          const { stats, expectContention } = await raceProcess(
            race,
            ids,
            claimers,
            limit,
          );
          await expectOneOwnerPerRow(race, ids, 1);
          expectContention();
          expect(sum(stats, 'claimed'), `round ${round} claimed`).toBe(rows);
          expect(sum(stats, 'completed'), `round ${round} completed`).toBe(
            rows,
          );
          expect(sum(stats, 'leaseLost'), `round ${round} lease lost`).toBe(0);
        }
      }
      expect(round).toBe(REPEATS * PROCESS_ROUNDS.length);
    }, 180_000);

    it('reclaims every expired lease for exactly one of the concurrent process() callers', async () => {
      const race = await openRace('lease_race_expired');
      let round = 0;
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const { claimers, rows, limit } of [
          { claimers: 5, rows: 1, limit: 100 },
          { claimers: 3, rows: 6, limit: 2 },
          { claimers: 4, rows: 15, limit: 4 },
        ]) {
          round++;
          const ids = Array.from({ length: rows }, (_, i) => `e${round}-${i}`);
          const stale = new Map<string, string>();
          for (const id of ids) {
            // A holder that stopped: its lease expired long ago.
            stale.set(id, `stale-${randomUUID()}`);
            await insertRawDispatch(race.ctx.db, {
              id,
              type: SIGNAL,
              status: 'processing',
              attempts: 1,
              leaseToken: stale.get(id),
              claimedUntil: PAST,
              maxAttempts: SETTINGS.maxAttempts,
            });
          }
          const { stats, expectContention } = await raceProcess(
            race,
            ids,
            claimers,
            limit,
          );
          await expectOneOwnerPerRow(race, ids, 2);
          expectContention();
          expect(sum(stats, 'completed'), `round ${round} completed`).toBe(
            rows,
          );
          // The stopped holder's late settle matches nothing.
          for (const id of ids) {
            const before = await dispatchLeaseRow(race.ctx.db, id);
            const late = await settleDispatchLease(
              race.ctx.db,
              {
                id,
                token: String(stale.get(id)),
                attempts: 1,
                claimedUntil: new Date(PAST),
              },
              { status: 'failed', error: 'late outcome' },
            );
            expect(late, `late settle of ${id}`).toBe(false);
            expect(await dispatchLeaseRow(race.ctx.db, id)).toEqual(before);
          }
        }
      }
    }, 180_000);

    it('a live holder whose lease was reclaimed reports lease-lost and its outcome is not written', async () => {
      const race = await openRace('lease_race_holder');
      for (const claimers of [1, 2, 4]) {
        const id = `h${claimers}`;
        await insertRawDispatch(race.ctx.db, { id, type: SIGNAL });
        // The holder is the last handle; the reclaimers are the others.
        const holder = race.buses[MAX_CLAIMERS - 1] as DispatchBus;
        let entered = () => {};
        const inHandler = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let finish = () => {};
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const holderStats: DispatchProcessStats[] = [];
        const holding = holder.process(
          SUBSCRIBER,
          async (_payload, metadata) => {
            race.log.handled.push({
              claimer: MAX_CLAIMERS - 1,
              id: metadata.id,
              attempts: metadata.attempts,
            });
            entered();
            await gate;
            throw new Error('outcome of a superseded attempt');
          },
          { limit: 1, onStats: (s) => holderStats.push(s) },
        );
        await inHandler;
        const held = await dispatchLeaseRow(race.ctx.db, id);
        expect(held.status).toBe('processing');
        // Expire the holder's lease explicitly.
        await race.ctx.db.query(
          'UPDATE _smrt_dispatch SET claimed_until = $1 WHERE id = $2',
          PAST,
          id,
        );

        const winsBefore = race.log.wins.length;
        const { stats, expectContention } = await raceProcess(
          race,
          [id],
          claimers,
          100,
        );
        const reclaims = race.log.wins
          .slice(winsBefore)
          .filter((win) => win.id === id);
        expect(
          reclaims.map((win) => win.attempts),
          `reclaims of ${id}`,
        ).toEqual([2]);
        expect(reclaims[0]?.token).not.toBe(held.leaseToken);
        expect(sum(stats, 'completed')).toBe(1);
        expectContention();

        finish();
        await holding;
        expect(holderStats).toHaveLength(1);
        expect(holderStats[0]).toMatchObject({
          claimed: 1,
          completed: 0,
          failed: 0,
          leaseLost: 1,
        });
        // One handler run per attempt; one settle, the reclaimer's.
        expect(
          race.log.handled
            .filter((call) => call.id === id)
            .map((call) => call.attempts)
            .sort((a, b) => a - b),
        ).toEqual([1, 2]);
        expect(race.log.settles.filter((settle) => settle.id === id)).toEqual([
          { claimer: reclaims[0]?.claimer, id },
        ]);
        const row = await dispatchLeaseRow(race.ctx.db, id);
        expect(row.status).toBe('completed');
        expect(row.attempts).toBe(2);
        expect(row.lastError).toBeNull();
        expect(row.leaseToken).toBe(reclaims[0]?.token);
      }
    }, 120_000);

    /** Release every claimer's claim of every row at once. */
    const raceClaims = async (
      race: RaceContext,
      ids: string[],
      claimers: number,
    ) => {
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const callStart = new Date();
      const attempts = race.handles.slice(0, claimers).flatMap((handle) =>
        ids.map(async (id) => {
          await gate;
          return claimDispatchLease(handle, {
            id,
            callStart,
            settings: SETTINGS,
          });
        }),
      );
      open();
      const results = await Promise.all(attempts);
      const owners = new Map<string, DispatchLease[]>();
      for (const lease of results) {
        if (!lease) continue;
        owners.set(lease.id, [...(owners.get(lease.id) ?? []), lease]);
      }
      return owners;
    };

    it('claim and reclaim give exactly one owner per row and only the owner settles', async () => {
      const race = await openRace('lease_race_claim');
      let round = 0;
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const claimers of [2, 3, 5]) {
          for (const rows of [1, 3, 8]) {
            round++;
            const ids = Array.from(
              { length: rows },
              (_, i) => `c${round}-${i}`,
            );
            for (const id of ids) {
              await insertRawDispatch(race.ctx.db, { id, type: SIGNAL });
            }
            const lossesBefore = race.log.losses.length;
            const first = await raceClaims(race, ids, claimers);
            for (const id of ids) {
              const leases = first.get(id) ?? [];
              expect(leases, `first owners of ${id}`).toHaveLength(1);
              const [owner] = leases as [DispatchLease];
              expect(owner.attempts).toBe(1);
              const row = await dispatchLeaseRow(race.ctx.db, id);
              expect(row).toMatchObject({
                status: 'processing',
                attempts: 1,
                leaseToken: owner.token,
              });
            }
            // Every claim that did not win came back empty.
            expect(race.log.losses.length - lossesBefore).toBe(
              rows * (claimers - 1),
            );
            const loserTokens = race.log.losses
              .slice(lossesBefore)
              .map((loss) => loss.token);

            // The lease expires; the claimers race again for every row.
            await race.ctx.db.query(
              `UPDATE _smrt_dispatch SET claimed_until = $1
                WHERE id IN (${inList(ids, 2)})`,
              PAST,
              ...ids,
            );
            const second = await raceClaims(race, ids, claimers);

            for (const id of ids) {
              const [previous] = first.get(id) as [DispatchLease];
              const leases = second.get(id) ?? [];
              expect(leases, `reclaim owners of ${id}`).toHaveLength(1);
              const [owner] = leases as [DispatchLease];
              expect(owner.attempts).toBe(2);
              expect(owner.token).not.toBe(previous.token);

              // Settles under any token but the live one write nothing:
              // the previous owner's, and every token a losing claim of
              // this round tried.
              const strangers = [previous.token, ...loserTokens];
              for (const token of strangers) {
                const lost = await settleDispatchLease(
                  race.ctx.db,
                  { ...owner, token },
                  { status: 'completed', subscriber: 'stranger' },
                );
                expect(lost, `stranger settle of ${id}`).toBe(false);
              }
              expect(await dispatchLeaseRow(race.ctx.db, id)).toMatchObject({
                status: 'processing',
                attempts: 2,
                leaseToken: owner.token,
              });

              expect(
                await settleDispatchLease(race.ctx.db, owner, {
                  status: 'completed',
                  subscriber: SUBSCRIBER,
                }),
              ).toBe(true);
              // Settling twice is not possible either.
              expect(
                await settleDispatchLease(race.ctx.db, owner, {
                  status: 'failed',
                  error: 'second outcome',
                }),
              ).toBe(false);
              expect(await dispatchLeaseRow(race.ctx.db, id)).toMatchObject({
                status: 'completed',
                attempts: 2,
                leaseToken: owner.token,
                lastError: null,
              });
            }
          }
        }
      }
    }, 180_000);
  },
);

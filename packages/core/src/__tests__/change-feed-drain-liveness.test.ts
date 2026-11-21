/**
 * The change-feed drain parser and the root drainer's rules (#5402, #5403).
 *
 * Stub PostgreSQL handles, so this runs in the default lane:
 * - any error row voids every entry row of that call, which is never counted
 *   or signalled;
 * - a handle that may be inside a caller transaction calls only the
 *   two-argument drain, one statement on the write path;
 * - the root drainer re-arms while a status reports work it could not
 *   finish, doubles its wait after a timeout (capped), halves it after a
 *   cancelled statement, keeps retrying observed work through connection
 *   failures, stops after five failures with nothing observed, ends silently
 *   on a closed root, and never holds the event loop.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  changeFeedDrainerSnapshot,
  drainChangeFeed,
  probeChangeFeedHelperState,
  resetChangeFeedWarnings,
  settleChangeFeedDrainers,
  stopChangeFeedDrainers,
} from '../change-feed';
import { subscribeToChangeSignals } from '../change-signals';

type Row = Record<string, unknown>;

interface FakeRoot extends DatabaseInterface {
  client: { ended: boolean };
  calls: string[];
  statusCalls: Array<Record<string, unknown>>;
}

function statusRow(
  status: string,
  backlog: boolean | null = false,
  helpers: boolean | null = true,
): Row {
  return {
    drained_seq: null,
    error_code: null,
    status,
    backlog_remaining: backlog,
    helpers_current: helpers,
  };
}

function entry(seq: number): Row {
  return {
    drained_seq: seq,
    drained_table: 'drain_liveness_unit',
    drained_row_id: `row-${seq}`,
    drained_operation: 'update',
    drained_tenant_id: null,
    error_code: null,
    status: null,
  };
}

/**
 * A root-shaped PostgreSQL stub. `onStatus(options, call)` answers each
 * status-drain call (or throws, to model a connection failure).
 */
function fakeRoot(
  onStatus: (options: Record<string, unknown>, call: number) => Row[],
): FakeRoot {
  const root = {
    url: `postgres://drain-liveness-unit/${Math.random().toString(36).slice(2)}`,
    client: { ended: false },
    calls: [] as string[],
    statusCalls: [] as Array<Record<string, unknown>>,
    query: async (sql: string, ...params: unknown[]) => {
      root.calls.push(sql);
      if (sql.includes('AS append_version')) {
        return [
          {
            table_name: '_smrt_changes',
            pending_table_name: '_smrt_changes_pending',
            // Current helpers: v8 since #5438, the version routine included.
            append_version: 8,
            batch_version: 8,
            drain_version: 8,
            compat_drain_version: 8,
            status_drain_version: 8,
            version_routine_version: 8,
            created_at_type: 'timestamp with time zone',
          },
        ];
      }
      // The status drain: parameterized, or (drainer passes) one statement
      // with dollar-quoted literals.
      const inlined = /\$smrt\$(\{[^$]*\})\$smrt\$::jsonb\)$/.exec(sql);
      if (
        sql.includes('_smrt_drain_changes(') &&
        (params.length === 2 || inlined)
      ) {
        const options = JSON.parse(
          String(inlined ? inlined[1] : params[1]),
        ) as Record<string, unknown>;
        root.statusCalls.push(options);
        return onStatus(options, root.statusCalls.length);
      }
      if (sql.includes('pg_current_xact_id_if_assigned() IS NULL')) {
        return [{ committed: true }];
      }
      return [];
    },
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(root),
    beginTransaction: async () => ({}),
    close: async () => {
      root.client.ended = true;
    },
  };
  return root as unknown as FakeRoot;
}

/** Make the stub a known root whose helpers have the status drain. */
async function asProbedRoot(root: FakeRoot): Promise<FakeRoot> {
  expect(await probeChangeFeedHelperState(root)).toBe('current');
  return root;
}

describe('change-feed drain parsing and the root drainer (#5402, #5403)', () => {
  beforeEach(() => {
    resetChangeFeedWarnings();
  });

  afterEach(async () => {
    vi.useRealTimers();
    stopChangeFeedDrainers();
    await settleChangeFeedDrainers();
    vi.restoreAllMocks();
  });

  it('voids every entry of a call that returned an error row', async () => {
    const root = await asProbedRoot(
      fakeRoot(() => [
        entry(1),
        entry(2),
        {
          drained_seq: null,
          error_code: '57014',
          error_message: 'canceling statement due to statement timeout',
          status: null,
        },
      ]),
    );
    const signals: unknown[] = [];
    const unsubscribe = subscribeToChangeSignals(root, (signal) => {
      signals.push(signal);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(drainChangeFeed(root)).rejects.toMatchObject({
        code: '57014',
      });
      expect(signals).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('calls only the two-argument drain, once, on the write path of a transaction handle', async () => {
    const calls: string[] = [];
    const tx = {
      url: `postgres://drain-liveness-unit/${Math.random().toString(36).slice(2)}`,
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('_smrt_append_change(')) {
          return [{ allocated_seq: null, error_code: null }];
        }
        return [];
      },
      commit: async () => {},
      rollback: async () => {},
      transaction: async () => {},
    } as unknown as DatabaseInterface;
    expect(await appendChange(tx, { table: 'drain_liveness_unit' })).toBeNull();
    const drains = calls.filter((sql) => sql.includes('_smrt_drain_changes('));
    expect(drains).toHaveLength(1);
    expect(drains[0]).toMatch(/jsonb_array_elements_text\(\$1::jsonb\)\)\)$/);
    expect(calls).toHaveLength(2);
  });

  it('re-arms while backlog is unknown and the last batch was full, and stops after a short one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // A role that cannot see the staging backlog: every status says NULL.
    const full = [
      ...Array.from({ length: 1000 }, (_, i) => entry(i + 1)),
      statusRow('drained', null),
    ];
    let short = false;
    const root = await asProbedRoot(
      fakeRoot((_options, call) => {
        if (call === 1) return [statusRow('head_busy', true)];
        if (!short) return full;
        return call % 2 === 0
          ? [entry(1), statusRow('drained', null)]
          : [statusRow('empty', null)];
      }),
    );
    expect(await drainChangeFeed(root)).toBe(0);
    // One pass sequences up to 50 full batches; still full, so it re-arms.
    await vi.advanceTimersByTimeAsync(300);
    expect(root.statusCalls).toHaveLength(51);
    expect(changeFeedDrainerSnapshot(root)?.scheduled).toBe(true);
    short = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(changeFeedDrainerSnapshot(root)?.scheduled).toBe(false);
    const calls = root.statusCalls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(root.statusCalls).toHaveLength(calls);
  });

  it('waits on a root whose helpers were never probed, probing them first', async () => {
    const root = fakeRoot(() => [entry(1), statusRow('drained', false)]);
    expect(await drainChangeFeed(root, { wait: true })).toBe(1);
    expect(root.statusCalls[0]).toEqual({ waitMs: 2000 });
    const probe = root.calls.findIndex((sql) =>
      sql.includes('AS append_version'),
    );
    const drain = root.calls.findIndex((sql) =>
      sql.startsWith('SELECT * FROM _smrt_drain_changes('),
    );
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(probe).toBeLessThan(drain);
  });

  it('runs every drainer pass as a waiting, first-statement-only call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const root = await asProbedRoot(
      fakeRoot((_options, call) =>
        call === 1 ? [statusRow('head_busy', true)] : [statusRow('empty')],
      ),
    );
    await drainChangeFeed(root);
    expect(root.statusCalls[0]).toEqual({});
    await vi.advanceTimersByTimeAsync(300);
    // A drainer's first pass also retries blocked gap markers (#5438), then
    // at most every ten minutes.
    expect(root.statusCalls[1]).toEqual({
      waitMs: 2000,
      firstStatement: true,
      retryBlocked: true,
    });
  });

  it('doubles the wait after each timeout up to 30 s, and halves it after a cancelled statement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let mode: 'timeout' | 'cancel' | 'empty' = 'timeout';
    const root = await asProbedRoot(
      fakeRoot((_options, call) => {
        if (call === 1) return [statusRow('head_busy', true)];
        if (mode === 'timeout') return [statusRow('timeout', true)];
        if (mode === 'cancel') {
          return [
            {
              drained_seq: null,
              error_code: '57014',
              error_message: 'canceled',
              status: null,
            },
          ];
        }
        return [statusRow('empty')];
      }),
    );
    await drainChangeFeed(root);
    await vi.advanceTimersByTimeAsync(120_000);
    const waits = root.statusCalls.slice(1).map((options) => options.waitMs);
    expect(waits.slice(0, 7)).toEqual([
      2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    mode = 'cancel';
    const before = root.statusCalls.length;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(root.statusCalls.length).toBeGreaterThan(before);
    expect(changeFeedDrainerSnapshot(root)?.waitMs).toBeLessThan(30000);
    expect(root.statusCalls[before]?.waitMs).toBe(30000);
    expect(root.statusCalls[before + 1]?.waitMs).toBe(15000);
    mode = 'empty';
    await vi.advanceTimersByTimeAsync(61_000);
    expect(changeFeedDrainerSnapshot(root)?.scheduled).toBe(false);
  });

  it('keeps retrying observed work through connection failures and drains after recovery', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let down = false;
    const root = await asProbedRoot(
      fakeRoot((_options, call) => {
        if (call === 1) return [statusRow('head_busy', true)];
        if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
        return [entry(1), statusRow('drained', false)];
      }),
    );
    await drainChangeFeed(root);
    down = true;
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    const snapshot = changeFeedDrainerSnapshot(root);
    expect(snapshot?.transportFailures).toBeGreaterThan(5);
    expect(snapshot?.scheduled).toBe(true);
    down = false;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(changeFeedDrainerSnapshot(root)).toMatchObject({
      scheduled: false,
      transportFailures: 0,
    });
  });

  it('stops after five connection failures when it has observed no work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = await asProbedRoot(
      fakeRoot(() => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }),
    );
    // A root's first feed call starts one pass; nothing has been observed.
    await expect(drainChangeFeed(root)).rejects.toThrow(/ECONNREFUSED/);
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    expect(root.statusCalls.length).toBe(6);
    expect(changeFeedDrainerSnapshot(root)).toMatchObject({
      scheduled: false,
      transportFailures: 5,
    });
  });

  it('ends silently on a closed root, and never holds the event loop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = await asProbedRoot(
      fakeRoot((_options, call) =>
        call === 1 ? [statusRow('head_busy', true)] : [statusRow('empty')],
      ),
    );
    await drainChangeFeed(root);
    expect(changeFeedDrainerSnapshot(root)).toMatchObject({
      scheduled: true,
      timerHasRef: false,
    });
    await root.close?.();
    await settleChangeFeedDrainers();
    expect(changeFeedDrainerSnapshot(root)).toMatchObject({
      scheduled: false,
      terminal: true,
    });
    expect(root.statusCalls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

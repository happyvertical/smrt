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
  twoArgCalls: number;
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
  onStatus: (
    options: Record<string, unknown>,
    call: number,
  ) => Row[] | Promise<Row[]>,
  extra: {
    url?: string;
    /** Answers any other statement first; undefined falls through. */
    onOther?: (sql: string, params: unknown[]) => Row[] | undefined;
    client?: Record<string, unknown>;
  } = {},
): FakeRoot {
  const root = {
    url:
      extra.url ??
      `postgres://drain-liveness-unit/${Math.random().toString(36).slice(2)}`,
    client: { ended: false, ...extra.client },
    calls: [] as string[],
    statusCalls: [] as Array<Record<string, unknown>>,
    twoArgCalls: 0,
    query: async (sql: string, ...params: unknown[]) => {
      root.calls.push(sql);
      const other = extra.onOther?.(sql, params);
      if (other !== undefined) return other;
      if (sql.includes('AS append_version')) {
        return [
          {
            table_name: '_smrt_changes',
            pending_table_name: '_smrt_changes_pending',
            append_version: 7,
            batch_version: 7,
            drain_version: 7,
            compat_drain_version: 7,
            status_drain_version: 7,
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
      if (sql.includes('SELECT * FROM _smrt_drain_changes(')) {
        root.twoArgCalls += 1;
        return [];
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
    stopChangeFeedDrainers();
    // A pass still running may be waiting on a fake timer: let it finish
    // before real timers return.
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(120_000);
    stopChangeFeedDrainers();
    vi.useRealTimers();
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

  it('treats a lock timeout after sequencing began as contention: entries voided, nothing thrown, the drainer takes over', async () => {
    const root = await asProbedRoot(
      fakeRoot((_options, call) =>
        call === 1
          ? [
              entry(1),
              {
                drained_seq: null,
                error_code: '55P03',
                error_message: 'canceling statement due to lock timeout',
                status: null,
              },
            ]
          : [statusRow('empty')],
      ),
    );
    const signals: unknown[] = [];
    const unsubscribe = subscribeToChangeSignals(root, (signal) => {
      signals.push(signal);
    });
    try {
      expect(await drainChangeFeed(root)).toBe(0);
      expect(signals).toEqual([]);
      expect(changeFeedDrainerSnapshot(root)).toMatchObject({
        scheduled: true,
        observedWork: true,
      });
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
    expect(root.statusCalls[1]).toEqual({ waitMs: 2000, firstStatement: true });
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

  it('runs one more pass for a kick that arrives while a pass that finds nothing is running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let release!: (rows: Row[]) => void;
    const held = new Promise<Row[]>((resolve) => {
      release = resolve;
    });
    const root = await asProbedRoot(
      fakeRoot(
        (_options, call) => {
          if (call === 1) return [statusRow('head_busy', true)];
          if (call === 2) return held;
          return [statusRow('empty')];
        },
        {
          onOther: (sql) =>
            sql.includes('FROM _smrt_append_change(')
              ? [{ allocated_seq: null, error_code: null }]
              : undefined,
        },
      ),
    );
    await drainChangeFeed(root);
    await vi.advanceTimersByTimeAsync(300);
    expect(root.statusCalls).toHaveLength(2);
    // A staged append on the root commits while that pass is in flight.
    expect(await appendChange(root, { table: 'drain_liveness_unit' })).toBe(
      null,
    );
    const beforeRelease = root.statusCalls.length;
    release([statusRow('empty')]);
    await vi.advanceTimersByTimeAsync(300);
    expect(root.statusCalls.length).toBe(beforeRelease + 1);
    expect(root.statusCalls.at(-1)).toMatchObject({ firstStatement: true });
  });

  it('keeps retrying a committed staged entry through more than five connection failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = await asProbedRoot(
      fakeRoot(
        () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
        },
        {
          onOther: (sql) =>
            sql.includes('FROM _smrt_append_change(')
              ? [{ allocated_seq: null, error_code: null }]
              : undefined,
        },
      ),
    );
    // The append stages (its write-path drain failed, which it tolerates).
    expect(await appendChange(root, { table: 'drain_liveness_unit' })).toBe(
      null,
    );
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    expect(changeFeedDrainerSnapshot(root)).toMatchObject({
      scheduled: true,
      observedWork: true,
    });
    expect(changeFeedDrainerSnapshot(root)?.transportFailures).toBeGreaterThan(
      5,
    );
  });

  it('spends one wait budget across every batch of a waiting call', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const full = [
      ...Array.from({ length: 1000 }, (_, i) => entry(i + 1)),
      statusRow('drained', true),
    ];
    const root = await asProbedRoot(
      fakeRoot(() => {
        clock += 800;
        return full;
      }),
    );
    await drainChangeFeed(root, { wait: true });
    expect(root.statusCalls.map((options) => options.waitMs)).toEqual([
      2000, 1200, 400,
    ]);
  });

  it('falls back to the protected drain when the SDK reports a refused status drain on the wrapped driver error', async () => {
    const root = await asProbedRoot(
      fakeRoot(() => {
        throw Object.assign(new Error('Failed to execute raw query'), {
          code: 'DATABASE_ERROR',
          cause: Object.assign(
            new Error('function _smrt_drain_changes does not exist'),
            { code: '42883' },
          ),
        });
      }),
    );
    expect(await drainChangeFeed(root, { wait: true })).toBe(0);
    expect(root.statusCalls).toHaveLength(1);
    expect(root.twoArgCalls).toBe(1);
    // The capability is invalidated: the next call goes straight there.
    expect(await drainChangeFeed(root)).toBe(0);
    expect(root.statusCalls).toHaveLength(1);
    expect(root.twoArgCalls).toBe(2);
  });

  it('backs off and retries after a pass gives up on repeated sequence conflicts', async () => {
    // The conflict budget runs on performance.now(), so fake that too.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let conflicting = true;
    const root = await asProbedRoot(
      fakeRoot((_options, call) => {
        if (call === 1) return [statusRow('head_busy', true)];
        if (conflicting) {
          return [
            {
              drained_seq: null,
              error_code: '23505',
              error_message: 'duplicate key value violates unique constraint',
              status: null,
            },
          ];
        }
        return [entry(1), statusRow('drained', false)];
      }),
    );
    await drainChangeFeed(root);
    await vi.advanceTimersByTimeAsync(10_000);
    // Still at it (a pass running or the next one scheduled), more than one
    // pass in: a give-up is not read as an idle feed.
    const busy = changeFeedDrainerSnapshot(root);
    expect(busy?.scheduled || busy?.running).toBe(true);
    const passesSoFar = root.statusCalls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(root.statusCalls.length).toBeGreaterThan(passesSoFar);
    conflicting = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(changeFeedDrainerSnapshot(root)?.scheduled).toBe(false);
  });

  it('never reinstalls helpers from the background on a root whose one session a caller can share', async () => {
    const root = fakeRoot(() => [statusRow('empty')], {
      client: { isInTransaction: () => false },
      // An older installer restored one body: the status drain is v7, the
      // batch append v6.
      onOther: (sql) =>
        sql.includes('AS append_version')
          ? [
              {
                table_name: '_smrt_changes',
                pending_table_name: '_smrt_changes_pending',
                append_version: 7,
                batch_version: 6,
                drain_version: 7,
                compat_drain_version: 7,
                status_drain_version: 7,
                created_at_type: 'timestamp with time zone',
              },
            ]
          : undefined,
    });
    // The first feed call starts a pass, which probes the never-probed root.
    await drainChangeFeed(root);
    await settleChangeFeedDrainers();
    expect(root.calls.some((sql) => sql.includes('AS append_version'))).toBe(
      true,
    );
    expect(root.calls.some((sql) => /^\s*DO\b/.test(sql))).toBe(false);
  });

  it('never calls the status drain on a root whose one session a caller can share', async () => {
    const root = fakeRoot(() => [statusRow('drained', false)], {
      client: { isInTransaction: () => false },
    });
    await probeChangeFeedHelperState(root);
    await drainChangeFeed(root, { wait: true });
    expect(root.statusCalls).toHaveLength(0);
    expect(root.twoArgCalls).toBe(1);
  });

  it('never writes a connection string’s credentials into a drainer warning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = await asProbedRoot(
      fakeRoot(() => [statusRow('head_busy', true)], {
        url: `postgres://runtime:s3cr3t-pass@db.internal/feed_${Math.random().toString(36).slice(2)}`,
      }),
    );
    await drainChangeFeed(root);
    await vi.advanceTimersByTimeAsync(120_000);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('unsequenced for 30 s');
    expect(logged).not.toContain('s3cr3t-pass');
  });

  it('on one shared session, publishes a drained entry only when the committed log shows it, not on a commit probe alone', async () => {
    let committedRows: Row[] = [];
    let drains = 0;
    const root = fakeRoot(() => [], {
      client: { isInTransaction: () => false },
      onOther: (sql) => {
        if (sql.startsWith('SELECT * FROM _smrt_drain_changes(')) {
          drains += 1;
          return drains === 1 ? [entry(7)] : [];
        }
        // A caller's raw transaction ran the pass and rolled back: no
        // transaction id is left for the probe to see.
        if (sql.includes('pg_current_xact_id_if_assigned() IS NULL')) {
          return [{ committed: true }];
        }
        if (sql.includes('FROM _smrt_changes WHERE seq IN')) {
          return committedRows;
        }
        return undefined;
      },
    });
    const signals: Array<{ seq: number }> = [];
    const unsubscribe = subscribeToChangeSignals(root, (signal) => {
      signals.push(signal as { seq: number });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await drainChangeFeed(root)).toBe(1);
      expect(signals).toEqual([]);
      // Once the log holds that exact entry, the queued signal publishes.
      committedRows = [
        {
          seq: 7,
          table_name: 'drain_liveness_unit',
          row_id: 'row-7',
          operation: 'update',
          tenant_id: null,
        },
      ];
      stopChangeFeedDrainers();
      await drainChangeFeed(root);
      expect(signals.map((signal) => signal.seq)).toEqual([7]);
    } finally {
      unsubscribe();
    }
  });

  it('keeps work a staged commit owed across the pass it arrived during, through more than five failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release!: (rows: Row[]) => void;
    const held = new Promise<Row[]>((resolve) => {
      release = resolve;
    });
    let down = false;
    const root = await asProbedRoot(
      fakeRoot(
        (_options, call) => {
          if (call === 1) return [statusRow('head_busy', true)];
          if (call === 2) return held;
          if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
          return [statusRow('empty')];
        },
        {
          onOther: (sql) =>
            sql.includes('FROM _smrt_append_change(')
              ? [{ allocated_seq: null, error_code: null }]
              : undefined,
        },
      ),
    );
    await drainChangeFeed(root);
    await vi.advanceTimersByTimeAsync(300);
    expect(root.statusCalls).toHaveLength(2);
    // A staged append commits during the pass; its write-path drain is the
    // third status call.
    expect(await appendChange(root, { table: 'drain_liveness_unit' })).toBe(
      null,
    );
    down = true;
    release([statusRow('empty')]);
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    expect(changeFeedDrainerSnapshot(root)).toMatchObject({
      scheduled: true,
      observedWork: true,
    });
    expect(changeFeedDrainerSnapshot(root)?.transportFailures).toBeGreaterThan(
      5,
    );
  });

  it('remembers backlog a batch reported when a later batch of the same pass fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const full = [
      ...Array.from({ length: 1000 }, (_, i) => entry(i + 1)),
      statusRow('drained', true),
    ];
    const root = await asProbedRoot(
      fakeRoot((_options, call) => {
        if (call === 1) return full;
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }),
    );
    // The root's first feed call starts a pass: it sequences one full batch
    // that reports more, and its next batch fails.
    await getTableVersionSafely(root);
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    expect(changeFeedDrainerSnapshot(root)).toMatchObject({
      scheduled: true,
      observedWork: true,
    });
  });

  it('spends the wait budget from the start of the call, its first batch included', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const root = fakeRoot(() => [statusRow('empty')], {
      onOther: (sql) => {
        if (sql.includes('AS append_version')) {
          // The helper probe of a never-probed root takes 600 ms.
          clock += 600;
        }
        return undefined;
      },
    });
    await drainChangeFeed(root, { wait: true });
    expect(root.statusCalls[0]).toEqual({ waitMs: 1400 });
  });

  it('settles queued signals after the passes of a waiting call, never before them', async () => {
    let committed = false;
    const root = await asProbedRoot(
      fakeRoot(
        (options) =>
          options.waitMs
            ? [statusRow('empty')]
            : [entry(3), statusRow('drained', false)],
        {
          onOther: (sql) => {
            if (sql.includes('pg_current_xact_id_if_assigned() IS NULL')) {
              return [{ committed }];
            }
            if (sql.includes('FROM _smrt_changes WHERE seq IN')) return [];
            return undefined;
          },
        },
      ),
    );
    // A drain whose commit cannot be proven queues its signal.
    await drainChangeFeed(root);
    committed = true;
    root.calls.length = 0;
    await drainChangeFeed(root, { wait: true });
    const status = root.calls.findIndex((sql) =>
      sql.includes('_smrt_drain_changes(1000'),
    );
    const verify = root.calls.findIndex((sql) =>
      sql.includes('FROM _smrt_changes WHERE seq IN'),
    );
    expect(status).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(status);
  });

  it('reinstalls restored older helpers on a pool from the drainer at most once per probe result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = fakeRoot(
      // Two caller drains each move one entry and report older helpers;
      // passes after that find nothing.
      (options) =>
        options.waitMs
          ? [statusRow('empty', false, null)]
          : [entry(1), statusRow('drained', false, false)],
      {
        onOther: (sql) => {
          if (sql.includes('AS append_version')) {
            return [
              {
                table_name: '_smrt_changes',
                pending_table_name: '_smrt_changes_pending',
                append_version: 7,
                batch_version: 6,
                drain_version: 7,
                compat_drain_version: 7,
                status_drain_version: 7,
                created_at_type: 'timestamp with time zone',
              },
            ];
          }
          if (/^\s*DO\b/.test(sql)) {
            throw Object.assign(new Error('must be owner of function'), {
              code: '42501',
            });
          }
          return undefined;
        },
      },
    );
    expect(await probeChangeFeedHelperState(root)).toBe('mixed');
    for (let i = 0; i < 2; i += 1) {
      // Each caller drain reports the older helpers and hands over.
      await drainChangeFeed(root);
      await settleChangeFeedDrainers();
    }
    expect(root.calls.filter((sql) => /^\s*DO\b/.test(sql))).toHaveLength(1);
  });
});

/** A root's first feed call, through the version read. */
async function getTableVersionSafely(root: FakeRoot): Promise<void> {
  const { getTableVersion } = await import('../change-feed');
  try {
    await getTableVersion(root, 'drain_liveness_unit');
  } catch {
    // The stub answers the version read with no row; only the kick matters.
  }
}

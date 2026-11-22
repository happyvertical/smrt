/**
 * Durable dedupe of dispatch-delivered agent invocations (#5525).
 *
 * A dispatch row can reach `processAgentInvocations` more than once (operator
 * `retry()`, a lease reclaim after a crash, two processors holding the same
 * row). These tests deliver the same row again and assert that paid work
 * starts at most once, that a recorded result is republished rather than
 * recomputed, that an unrecorded reservation becomes `uncertain` (never
 * rerun) with a completion that unblocks the orchestrator, that completions
 * are surfaced once per invocation, and that processing refuses to start
 * without the ledger table.
 *
 * Runs on SQLite by default and on PGlite under `pnpm test:pglite`
 * (`SMRT_TEST_PGLITE=1`). PostgreSQL-only cases live in
 * `invoke-agent-dedupe-postgres.optional.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDispatchBus,
  type Dispatch,
  type DispatchBus,
  type DispatchHandler,
  getTestDatabase,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DelegationEnvelope,
  rootDelegationEnvelope,
} from './delegation.js';
import {
  agentInvokeSignalType,
  createDispatchInvokeTransport,
  processAgentInvocations,
  surfaceAgentCompletions,
  type WorkerRunner,
} from './invoke-agent.js';

const engine = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const ORIGINATOR = 'dedupe-originator';
const LEDGER = '_smrt_agent_invocations';
const RUN_AS_USER_ID = '3c9a1f52-7d4e-4b8a-9f0e-2a6b5c1d8e47';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return ((result as { rows?: Record<string, unknown>[] })?.rows ??
    []) as Record<string, unknown>[];
}

/** A view of `bus` whose `process()` hands `row` to the handler once more. */
function redeliveringBus(bus: DispatchBus, row: Dispatch): DispatchBus {
  return new Proxy(bus, {
    get(target, property) {
      if (property === 'process') {
        return async (_subscriber: string, handler: DispatchHandler) => {
          await handler(row.payload, row.getMetadata());
          return 1;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * A view of `bus` whose next `agent.completed` emit fails, either before the
 * row is written (`before`) or after it was written (`after`).
 */
function completionFaultBus(
  bus: DispatchBus,
  when: 'before' | 'after',
): DispatchBus {
  let armed = true;
  return new Proxy(bus, {
    get(target, property) {
      if (property === 'emit') {
        return async (...args: Parameters<DispatchBus['emit']>) => {
          if (!armed || args[0] !== 'agent.completed') {
            return target.emit(...args);
          }
          armed = false;
          if (when === 'after') {
            await target.emit(...args);
          }
          throw new Error(`completion emit interrupted (${when} write)`);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe(`invoke-agent durable dedupe (${engine})`, () => {
  let db: DatabaseInterface;
  let dbPath: string | undefined;
  let bus: DispatchBus;
  let tenantId: string;

  beforeEach(async () => {
    if (engine === 'pglite') {
      dbPath = undefined;
      db = await getTestDatabase({ type: 'pglite' });
    } else {
      dbPath = join(tmpdir(), `smrt-invoke-dedupe-${randomUUID()}.db`);
      db = await getTestDatabase({ type: 'sqlite', url: dbPath });
    }
    const tenants = await TenantCollection.create({ db });
    const tenant = await tenants.create({ name: 'Dedupe Org' });
    await tenant.save();
    tenantId = tenant.id as string;
    bus = await createDispatchBus({ db });
  });

  afterEach(async () => {
    await db?.close?.();
    if (dbPath) rmSync(dbPath, { force: true });
  });

  function envelope(correlationId: string): DelegationEnvelope {
    return {
      ...rootDelegationEnvelope({
        // PostgreSQL keeps user ids in native uuid columns.
        runAsUserId: RUN_AS_USER_ID,
        tenantId,
        onBehalfOfUserId: ORIGINATOR,
      }),
      depth: 1,
      correlationId,
    };
  }

  /** Enqueue one invocation through the async transport and return its row. */
  async function enqueue(
    correlationId: string,
    agentClass = '@happyvertical/smrt-agents:DedupeWorker',
  ): Promise<Dispatch> {
    await createDispatchInvokeTransport(bus).deliver({
      envelope: envelope(correlationId),
      agentClass,
      task: { unit: correlationId },
      worker: async () => undefined,
      dispatchBus: bus,
    });
    const [row] = await bus.list({
      type: agentInvokeSignalType(agentClass),
      correlationId,
    });
    if (!row) throw new Error('invocation row was not enqueued');
    return row;
  }

  async function ledgerRows(
    dispatchId: string,
  ): Promise<Record<string, unknown>[]> {
    return rowsOf(
      await db.query(
        `SELECT state, attempts_seen, tenant_id, result_json FROM ${LEDGER} WHERE dispatch_id = ?`,
        dispatchId,
      ),
    );
  }

  it('runs a single delivery once and publishes one completion tagged with its invocation id', async () => {
    const row = await enqueue('corr-single');
    let calls = 0;
    const processed = await processAgentInvocations({
      dispatchBus: bus,
      subscriber: 'DedupeWorker',
      worker: async () => {
        calls += 1;
        return { summary: 'done' };
      },
      db,
      audit: () => {},
    });
    expect(processed).toBe(1);
    expect(calls).toBe(1);

    const completions = await bus.list({
      type: 'agent.completed',
      correlationId: 'corr-single',
    });
    expect(completions).toHaveLength(1);
    expect(completions[0]?.metadata.invocationId).toBe(row.id);
    const [ledger] = await ledgerRows(row.id);
    expect(ledger?.state).toBe('published');
    expect(ledger?.tenant_id).toBe(tenantId);
    expect(await surfaceAgentCompletions(bus, 'corr-single')).toEqual([
      expect.objectContaining({ ok: true, result: { summary: 'done' } }),
    ]);
  });

  it('redelivered agent.invoke after provider acceptance is marked uncertain, not rerun', async () => {
    const row = await enqueue('corr-ag1');
    const accepted = deferred();
    const release = deferred();
    let providerCalls = 0;
    let idempotencyKey: string | undefined;
    const worker: WorkerRunner = async (invocation) => {
      providerCalls += 1;
      idempotencyKey = invocation.invocationId;
      accepted.resolve();
      // The first delivery stops here, after the provider accepted the work.
      if (providerCalls === 1) await release.promise;
      return { billed: providerCalls };
    };
    const redelivery = redeliveringBus(bus, row);
    const first = processAgentInvocations({
      dispatchBus: redelivery,
      subscriber: 'DedupeWorker',
      worker,
      db,
      audit: () => {},
    });
    await accepted.promise;

    await processAgentInvocations({
      dispatchBus: redelivery,
      subscriber: 'DedupeWorker',
      worker,
      db,
      audit: () => {},
    });

    expect(providerCalls).toBe(1);
    expect(idempotencyKey).toBe(row.id);
    const [ledger] = await ledgerRows(row.id);
    expect(ledger?.state).toBe('uncertain');
    expect(Number(ledger?.attempts_seen)).toBe(2);

    release.resolve();
    await first;
    expect(providerCalls).toBe(1);
  });

  it('concurrent redelivery of a global row under two tenant contexts reserves once', async () => {
    const row = await enqueue('corr-ag2');
    // Emitted outside any tenant context: a global dispatch row.
    expect(row.tenantId).toBeNull();
    let calls = 0;
    const worker: WorkerRunner = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { calls };
    };
    const redelivery = redeliveringBus(bus, row);
    const run = () =>
      processAgentInvocations({
        dispatchBus: redelivery,
        subscriber: 'DedupeWorker',
        worker,
        db,
        audit: () => {},
      });

    await Promise.all([
      withTenant({ tenantId: randomUUID() }, run),
      withTenant({ tenantId: randomUUID() }, run),
    ]);

    expect(calls).toBe(1);
    const ledger = await ledgerRows(row.id);
    expect(ledger).toHaveLength(1);
    // The ledger tenant is the envelope's, never the processing context's.
    expect(ledger[0]?.tenant_id).toBe(tenantId);
    expect(ledger[0]?.state).toBe('published');
  });

  it('crash before publication republishes; crash after publication does not double-report', async () => {
    const beforeClass = '@happyvertical/smrt-agents:BeforePublish';
    const afterClass = '@happyvertical/smrt-agents:AfterPublish';
    const before = await enqueue('corr-ag3-before', beforeClass);
    const after = await enqueue('corr-ag3-after', afterClass);
    const calls: Record<string, number> = {};
    const worker: WorkerRunner = async ({ agentClass }) => {
      calls[agentClass] = (calls[agentClass] ?? 0) + 1;
      return { from: agentClass };
    };
    const processWith = (
      dispatchBus: DispatchBus,
      agentClass: string,
      subscriber: string,
    ) =>
      processAgentInvocations({
        dispatchBus,
        subscriber,
        agentClass,
        worker,
        db,
        audit: () => {},
      });

    // The first delivery of each row stops at the completion emit.
    expect(
      await processWith(
        completionFaultBus(bus, 'before'),
        beforeClass,
        'BeforeSub',
      ),
    ).toBe(0);
    expect(
      await processWith(
        completionFaultBus(bus, 'after'),
        afterClass,
        'AfterSub',
      ),
    ).toBe(0);
    expect((await ledgerRows(before.id))[0]?.state).toBe('result_recorded');
    expect((await ledgerRows(after.id))[0]?.state).toBe('result_recorded');

    // Redeliver both failed rows through the ordinary retry path.
    expect(await bus.retry()).toBe(2);
    expect(await processWith(bus, beforeClass, 'BeforeSub')).toBe(1);
    expect(await processWith(bus, afterClass, 'AfterSub')).toBe(1);

    expect(calls[beforeClass]).toBe(1);
    expect(calls[afterClass]).toBe(1);
    expect((await ledgerRows(before.id))[0]?.state).toBe('published');
    expect((await ledgerRows(after.id))[0]?.state).toBe('published');

    const republished = await surfaceAgentCompletions(bus, 'corr-ag3-before');
    expect(republished).toEqual([
      expect.objectContaining({ ok: true, result: { from: beforeClass } }),
    ]);
    // The completion was written twice; it is reported once.
    expect(
      await bus.list({
        type: 'agent.completed',
        correlationId: 'corr-ag3-after',
      }),
    ).toHaveLength(2);
    expect(await surfaceAgentCompletions(bus, 'corr-ag3-after')).toEqual([
      expect.objectContaining({ ok: true, result: { from: afterClass } }),
    ]);
  });

  it('uncertain completion unblocks the orchestrator', async () => {
    const row = await enqueue('corr-ag5');
    const accepted = deferred();
    const release = deferred();
    let calls = 0;
    const worker: WorkerRunner = async () => {
      calls += 1;
      accepted.resolve();
      if (calls === 1) await release.promise;
      return { late: true };
    };
    const redelivery = redeliveringBus(bus, row);
    const first = processAgentInvocations({
      dispatchBus: redelivery,
      subscriber: 'DedupeWorker',
      worker,
      db,
      audit: () => {},
    });
    await accepted.promise;
    await processAgentInvocations({
      dispatchBus: redelivery,
      subscriber: 'DedupeWorker',
      worker,
      db,
      audit: () => {},
    });

    const surfaced = await surfaceAgentCompletions(bus, 'corr-ag5');
    expect(surfaced).toEqual([
      {
        correlationId: 'corr-ag5',
        agentClass: '@happyvertical/smrt-agents:DedupeWorker',
        onBehalfOfUserId: ORIGINATOR,
        ok: false,
        result: undefined,
        error: 'AGENT_INVOCATION_UNCERTAIN',
      },
    ]);

    // A late result from the stranded first delivery supersedes it.
    release.resolve();
    await first;
    expect(calls).toBe(1);
    expect(await surfaceAgentCompletions(bus, 'corr-ag5')).toEqual([
      expect.objectContaining({ ok: true, result: { late: true } }),
    ]);
  });

  it('processAgentInvocations fails closed without the ledger table', async () => {
    const row = await enqueue('corr-ag6');
    await db.query(`DROP TABLE ${LEDGER}`);
    let calls = 0;
    await expect(
      processAgentInvocations({
        dispatchBus: bus,
        subscriber: 'DedupeWorker',
        worker: async () => {
          calls += 1;
          return {};
        },
        db,
        audit: () => {},
      }),
    ).rejects.toMatchObject({ code: 'AGENT_INVOCATION_LEDGER_MISSING' });
    expect(calls).toBe(0);
    const [stillPending] = await bus.list({
      type: row.type,
      correlationId: 'corr-ag6',
    });
    expect(stillPending?.status).toBe('pending');
  });
});

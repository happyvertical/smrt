/**
 * PostgreSQL lane for the durable dedupe of dispatch-delivered agent
 * invocations (#5525). The SQLite/PGlite cases live in
 * `invoke-agent-dedupe.test.ts`.
 *
 * Proves, on a pooled PostgreSQL connection:
 *   - two concurrent deliveries of one global dispatch row, processed under
 *     different tenant contexts, reserve the invocation once;
 *   - the reservation is committed on the base handle, outside the
 *     principal's RLS transaction, so a worker whose transaction is lost still
 *     leaves a reservation and is not rerun on redelivery.
 *
 * Skipped unless `SMRT_TEST_POSTGRES_URL` is set; run it through
 * `pnpm --filter @happyvertical/smrt-agents test:postgres`.
 */

import { randomUUID } from 'node:crypto';
import {
  createDispatchBus,
  type Dispatch,
  type DispatchBus,
  type DispatchHandler,
  getTestDatabase,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DelegationEnvelope } from './delegation.js';
import {
  agentInvokeSignalType,
  createDispatchInvokeTransport,
  processAgentInvocations,
  type WorkerRunner,
} from './invoke-agent.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;
const LEDGER = '_smrt_agent_invocations';
const AGENT = '@happyvertical/smrt-agents:PgDedupeWorker';
const RLS_AGENT = '@happyvertical/smrt-agents:PgDedupeRlsWorker';

type Db = Awaited<ReturnType<typeof getDatabase>>;

function rowsOf(result: unknown): Record<string, unknown>[] {
  return ((result as { rows?: Record<string, unknown>[] })?.rows ??
    []) as Record<string, unknown>[];
}

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

postgresDescribe('invoke-agent durable dedupe (PostgreSQL)', () => {
  let db: Db;
  let observer: Db;
  let bus: DispatchBus;
  const dbid = `smrt-invoke-dedupe-${randomUUID()}`;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid,
      max: 4,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    await getTestDatabase({
      db: db as never,
      classes: ['@happyvertical/smrt-agents:AgentInvocation'],
    });
    // A second, independent pool observes only committed state.
    observer = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `${dbid}-observer`,
      max: 1,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    bus = await createDispatchBus({ db: db as never });
  });

  afterAll(async () => {
    await db?.query(`DROP TABLE IF EXISTS ${LEDGER}`);
    await observer?.close?.();
    await db?.close?.();
  });

  function envelope(correlationId: string): DelegationEnvelope {
    // A global principal (no tenant) keeps this lane free of RBAC tables.
    return {
      runAsUserId: '8b2e4c6a-1f3d-4a5b-9c7e-0d2f4a6b8c1e',
      tenantId: null,
      onBehalfOfUserId: 'pg-dedupe-originator',
      depth: 1,
      correlationId,
    };
  }

  async function enqueue(
    correlationId: string,
    agentClass = AGENT,
  ): Promise<Dispatch> {
    await createDispatchInvokeTransport(bus).deliver({
      envelope: envelope(correlationId),
      agentClass,
      task: {},
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

  async function committedLedger(
    dispatchId: string,
  ): Promise<Record<string, unknown>[]> {
    return rowsOf(
      await observer.query(
        `SELECT state, attempts_seen FROM ${LEDGER} WHERE dispatch_id = $1`,
        dispatchId,
      ),
    );
  }

  it('concurrent redelivery of a global row under two tenant contexts reserves once', async () => {
    const row = await enqueue('pg-corr-ag2');
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
        subscriber: 'PgDedupeWorker',
        worker,
        db: db as never,
        audit: () => {},
      });

    await Promise.all([
      withTenant({ tenantId: randomUUID() }, run),
      withTenant({ tenantId: randomUUID() }, run),
      withTenant({ tenantId: randomUUID() }, run),
    ]);

    expect(calls).toBe(1);
    const ledger = await committedLedger(row.id);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]?.attempts_seen)).toBe(3);
  });

  it('reservation commits outside the RLS transaction that the worker crash rolls back', async () => {
    const row = await enqueue('pg-corr-ag4', RLS_AGENT);
    let calls = 0;
    let reservedWhileRunning: Record<string, unknown>[] = [];
    const worker: WorkerRunner = async ({ run }) => {
      calls += 1;
      const tx = run.context.database;
      if (!tx) throw new Error('principal context has no database');
      const pid = rowsOf(await tx.query('SELECT pg_backend_pid() AS pid'))[0]
        ?.pid;
      // Visible from an independent connection while the RLS transaction is
      // still open: the reservation was committed before the worker started.
      reservedWhileRunning = await committedLedger(row.id);
      // The worker's process dies: its transaction connection goes away.
      await observer.query('SELECT pg_terminate_backend($1)', pid);
      return { never: 'committed' };
    };
    const processOptions = {
      subscriber: 'PgDedupeRls',
      agentClass: RLS_AGENT,
      worker,
      db: db as never,
      audit: () => {},
      postgresRls: true,
    };

    expect(
      await processAgentInvocations({ ...processOptions, dispatchBus: bus }),
    ).toBe(0);
    expect(calls).toBe(1);
    expect(reservedWhileRunning).toEqual([
      expect.objectContaining({ state: 'reserved' }),
    ]);

    // Redeliver through the ordinary retry path: not rerun.
    expect(await bus.retry()).toBeGreaterThanOrEqual(1);
    expect(
      await processAgentInvocations({ ...processOptions, dispatchBus: bus }),
    ).toBe(1);
    expect(calls).toBe(1);
    expect(await committedLedger(row.id)).toEqual([
      expect.objectContaining({ state: 'uncertain' }),
    ]);
  });
});

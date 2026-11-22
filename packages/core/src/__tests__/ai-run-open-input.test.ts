/**
 * Opening a run reads one snapshot of its store and input
 * (docs/content/ai-runs.md section 3): each public property is read once,
 * getter-backed stores and class-instance inputs are honoured, a failure
 * while reading writes nothing, and every key of the input is taken. The
 * parent's depth is walked in the run's tenant and the row returned is the
 * one inserted, read in the open's transaction. Real SQLite and DuckDB
 * (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAiRun,
  type OpenAiRunInput,
  openAiRun,
  readAiRunCheckpoint,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  hasTenantPredicate,
  newAiRunTestDatabase,
  recordStatements,
  rowsOf,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (
  db: DatabaseInterface,
  tenantId: string | null = 'tenant-one',
) => ({ db, usageTracking: true, tenantId });

describe.each(aiRunTestEngines)('open input snapshot on %s', (engine) => {
  it('walks depth in its tenant and returns the row it inserted', async () => {
    const db = await newAiRunTestDatabase(engine);
    const root = await openAiRun(store(db), { type: 'workflow' });
    const parent = await openAiRun(store(db), {
      type: 'turn',
      parentRunId: root.id,
    });
    const unscoped: string[] = [];
    const restore = recordStatements(db, (sql, params) => {
      if (
        sql.startsWith('SELECT') &&
        sql.includes('FROM _smrt_ai_runs') &&
        !sql.includes('AS used') &&
        !hasTenantPredicate(sql)
      ) {
        unscoped.push(`${sql} ${JSON.stringify(params)}`);
      }
    });
    const child = await openAiRun(store(db), {
      id: 'depth-child',
      type: 'turn',
      parentRunId: parent.id,
    });
    restore();
    expect(child).toMatchObject({
      id: 'depth-child',
      tenantId: 'tenant-one',
      parentRunId: parent.id,
    });
    expect(unscoped).toEqual([]);
  });

  it('persists the tenant of a prototype getter', async () => {
    const db = await newAiRunTestDatabase(engine);
    class TenantStore {
      usageTracking = true;
      constructor(readonly db: DatabaseInterface) {}
      get tenantId() {
        return 'getter-tenant';
      }
    }
    const run = await openAiRun(new TenantStore(db), { type: 'turn' });
    expect(run.tenantId).toBe('getter-tenant');
    expect((await getAiRun(db, run.id))?.tenantId).toBe('getter-tenant');
  });

  it('opens with a getter-backed database and usage tracking', async () => {
    const db = await newAiRunTestDatabase(engine);
    class GetterStore {
      get db() {
        return db;
      }
      get usageTracking() {
        return true;
      }
    }
    const run = await openAiRun(new GetterStore(), { type: 'turn' });
    expect(await getAiRun(db, run.id)).not.toBeNull();
  });

  it('reads a varying getter once; a throwing getter writes nothing', async () => {
    const db = await newAiRunTestDatabase(engine);
    let reads = 0;
    const varying = {
      db,
      usageTracking: true,
      get tenantId() {
        reads++;
        return reads === 1 ? 'first-read' : 'later-read';
      },
    };
    const run = await openAiRun(varying, { type: 'turn' });
    expect(reads).toBe(1);
    expect((await getAiRun(db, run.id))?.tenantId).toBe('first-read');

    const statements: string[] = [];
    const restore = recordStatements(db, (sql) => statements.push(sql));
    const throwing = {
      db,
      usageTracking: true,
      get className(): string {
        throw new Error('getter failed');
      },
    };
    await expect(openAiRun(throwing, { type: 'turn' })).rejects.toThrow(
      'getter failed',
    );
    restore();
    expect(statements).toEqual([]);
  });

  it('honours class-instance input getters', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db), { type: 'workflow' });
    class Input {
      get id() {
        return 'class-input-id';
      }
      get type() {
        return 'turn';
      }
      get parentRunId() {
        return parent.id;
      }
      get handoff() {
        return { name: 'from-getter' };
      }
    }
    const run = await openAiRun(store(db), new Input() as OpenAiRunInput);
    expect(run).toMatchObject({
      id: 'class-input-id',
      parentRunId: parent.id,
    });
    expect(
      rowsOf(
        await db.query(
          "SELECT name FROM _smrt_ai_run_events WHERE type = 'handoff' AND child_run_id = $1",
          run.id,
        ),
      ),
    ).toEqual([{ name: 'from-getter' }]);
  });

  it('reads every input key once', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db), { type: 'workflow' });
    const full: Required<OpenAiRunInput> = {
      id: 'every-key',
      type: 'workflow',
      definitionKey: 'def',
      definitionVersion: '1',
      promptKey: 'prompt',
      templateHash: 'hash',
      ownerId: 'owner',
      parentRunId: parent.id,
      experimentId: null,
      datasetItem: 'item',
      tags: { a: 1 },
      budget: { maxCalls: 3 },
      durable: true,
      checkpoint: { state: { s: 1 }, lease: 'lease' },
      mode: null,
      handoff: { name: 'h' },
      retryOfRunId: null,
      retry: {},
    };
    const reads = new Map<string, number>();
    const input = new Proxy(full, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.set(property, (reads.get(property) ?? 0) + 1);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const run = await openAiRun(store(db), input);
    expect([...reads.keys()].sort()).toEqual(Object.keys(full).sort());
    for (const [key, count] of reads) expect(count, key).toBe(1);
    expect(run).toMatchObject({
      id: 'every-key',
      definitionKey: 'def',
      ownerId: 'owner',
      promptKey: 'prompt',
      templateHash: 'hash',
      datasetItem: 'item',
      tags: { a: 1 },
      durable: true,
    });
    expect(run.budget.maxCalls).toBe(3);
    expect((await readAiRunCheckpoint(db, run.id))?.lease).toBe('lease');
  });
});

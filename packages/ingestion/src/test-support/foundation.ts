import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  generateSchemaDiff,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import {
  getDDLStrategy,
  planForeignKeyCreation,
  SchemaGenerator,
} from '@happyvertical/smrt-core/schema';
import {
  SmrtJobCollection,
  SmrtJobEventCollection,
} from '@happyvertical/smrt-jobs';
import { createTaskRunner } from '@happyvertical/smrt-jobs/runner';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as models from '../models.js';
import {
  type IngestionOptions,
  IngestionService,
  type ReceiveInput,
} from '../server.js';
import { dropExecutionDatabase } from './postgres-cleanup.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const otherTenant = '22222222-2222-4222-8222-222222222222';
const classes = [
  ...Object.keys(models),
  'Asset',
  'AssetAssociation',
  'AssetTag',
  'AssetType',
  'AssetStatus',
  'Folder',
  'SmrtJob',
  'SmrtJobEvent',
  'SmrtWorker',
  // smrtVitestPlugin registers dev-dependency manifests package-wide. The
  // execution reference deliberately imports these noun-owned asset joins.
  'Content',
  'ContentDocument',
  'ContentAsset',
  'ContentContributionAttachment',
  'ProfileAsset',
];
const output = {
  status: 'completed' as const,
  provider: 'fixture',
  model: 'fixture',
  version: '1',
  output: { text: 'retained' },
  usage: { bytes: 8 },
  confidence: 0.875,
};

let hostOptions: IngestionOptions;
export async function runHostStage(
  db: DatabaseInterface,
  input: { itemId: string; revision: number },
): Promise<void> {
  await hostOptions.checkpoint?.('worker:before-process');
  const service = new IngestionService({ ...hostOptions, db });
  const analysis = await service.analyze(
    input.itemId,
    { provider: 'fixture' },
    `dispatch:${input.revision}`,
  );
  const lease = await service.claimAnalysis(
    input.itemId,
    analysis.revision,
    'real-job-worker',
  );
  if (lease) await service.completeAnalysis(lease, output);
}

export function foundationSuite(
  dialect: 'sqlite' | 'postgres',
  workerType: string,
): void {
  describe(`ingestion durability on ${dialect}`, () => {
    let db: DatabaseInterface;
    let peer: DatabaseInterface;
    let root: string;
    let admin: DatabaseInterface | undefined;
    let databaseName: string;
    let service: IngestionService;
    let options: IngestionOptions;
    let clock: Date;
    let allowed: boolean;
    let faults: Set<string>;
    let purges: number;
    function receive(key = 'delivery'): ReceiveInput {
      return {
        sourceId: 'account',
        sourceVersion: '1',
        deliveryKey: key,
        deliveredAt: new Date(clock),
        parts: [
          {
            partId: 'message',
            mediaType: 'text/plain',
            bytes: Buffer.from('retained original'),
          },
        ],
        capturedCeiling: { handlers: ['draft'] },
        retention: {
          version: '1',
          expiresAt: new Date(clock.getTime() + 100000),
          replayUntil: new Date(clock.getTime() + 200000),
          acceptAfter: new Date(clock.getTime() - 10000),
        },
        limits: {
          maxBytes: 4096,
          maxParts: 10,
          maxAttempts: 2,
          leaseMs: 100,
          maxOutputBytes: 4096,
        },
      };
    }
    async function accepted(key = 'delivery'): Promise<string> {
      const result = await service.receive(receive(key));
      expect(result.kind).toBe('accepted');
      if (!('itemId' in result)) throw new Error(JSON.stringify(result));
      return result.itemId;
    }
    async function analysis(itemId: string) {
      const a = await service.analyze(
        itemId,
        { provider: 'fixture' },
        'analysis',
      );
      const lease = await service.claimAnalysis(itemId, a.revision, 'worker');
      expect(lease).toBeTruthy();
      return lease!;
    }
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'ing-'));
      clock = new Date('2026-10-08T12:00:00Z');
      allowed = true;
      faults = new Set();
      purges = 0;
      if (dialect === 'postgres') {
        const base = process.env.DATABASE_URL;
        if (!base) throw new Error('PostgreSQL lane requires DATABASE_URL');
        admin = await getTestDatabase({
          type: 'postgres',
          url: base,
          classes: [],
          includeSystemTables: false,
        });
        databaseName = `ing_${randomUUID().replaceAll('-', '')}`;
        await admin.query(`CREATE DATABASE ${databaseName}`);
        const url = new URL(base);
        url.pathname = `/${databaseName}`;
        db = await getTestDatabase({
          type: 'postgres',
          url: url.toString(),
          classes: [...classes, workerType],
        });
        peer = await getTestDatabase({
          type: 'postgres',
          url: url.toString(),
          classes: [],
          includeSystemTables: false,
        });
      } else {
        const url = `file:${join(root, 'db.sqlite')}`;
        db = await getTestDatabase({
          type: 'sqlite',
          url,
          classes: [...classes, workerType],
        });
        peer = await getTestDatabase({
          type: 'sqlite',
          url,
          classes: [],
          includeSystemTables: false,
        });
      }
      options = {
        db,
        assets: await createAssetRuntime({ db, storage: join(root, 'assets') }),
        scope: {
          tenantId: tenant,
          actorId: 'owner',
          confidentialScopeId: 'confidential',
        },
        authorize: async ({ scope }) =>
          allowed && ['owner', 'delegate'].includes(scope.actorId),
        jobTarget: { objectType: workerType, method: 'process' },
        purgeDerived: async () => {
          purges++;
        },
        now: () => clock,
        checkpoint: async (name) => {
          if (faults.delete(name)) throw new Error(`Injected ${name}`);
        },
      };
      hostOptions = options;
      service = new IngestionService(options);
      await service.assertReady();
    });
    afterEach(async () => {
      await peer?.close?.();
      await db?.close?.();
      if (admin) {
        await dropExecutionDatabase(admin, databaseName);
        await admin.close?.();
        admin = undefined;
      }
      if (root) await rm(root, { recursive: true, force: true });
    });
    describe('dispatch route authority', () => {
      const json = (value: unknown): Record<string, unknown> =>
        typeof value === 'string'
          ? JSON.parse(value)
          : (value as Record<string, unknown>);
      async function intents(id: string) {
        return (
          await db.query(
            'SELECT * FROM intake_dispatches WHERE item_id=? ORDER BY revision',
            id,
          )
        ).rows;
      }
      async function legacy(id: string, keepJob = false) {
        const [item] = (
          await db.query('SELECT data FROM intake_items WHERE id=?', id)
        ).rows;
        const data = json(item.data);
        delete data.dispatchTarget;
        await db.query(
          'UPDATE intake_items SET data=? WHERE id=?',
          JSON.stringify(data),
          id,
        );
        await db.query(
          `UPDATE intake_dispatches SET data='{}'${keepJob ? '' : ",job_id=''"} WHERE item_id=?`,
          id,
        );
      }
      function recovery(dbOverride = db) {
        return new IngestionService({
          ...options,
          db: dbOverride,
          dispatchRecovery: { authorize: async () => true },
        });
      }
      async function unknown() {
        const id = await accepted(randomUUID());
        await legacy(id);
        const inspected = await service.inspectDispatchRoute(id);
        expect(inspected.status).toBe('unknown');
        return {
          id,
          input: {
            itemId: id,
            expectedFingerprint: inspected.fingerprint,
            evidenceRef: 'operator-review:fixture',
          },
        };
      }
      it('pins receipt and every revision, rejects cross-host replay/analysis, and snapshots mutable host options', async () => {
        const id = await accepted();
        const foreign = new IngestionService({
          ...options,
          jobTarget: { objectType: workerType, method: 'otherProcess' },
        });
        expect(await foreign.receive(receive())).toEqual({
          kind: 'rejected',
          category: 'conflict',
        });
        await expect(foreign.analyze(id, {}, 'foreign')).rejects.toThrow(
          'route',
        );
        const original = { ...options.jobTarget };
        options.jobTarget.method = 'otherProcess';
        await service.analyze(id, {}, 'initial');
        await service.analyze(id, {}, 'next');
        expect((await service.inspectDispatchRoute(id)).target).toEqual({
          version: 1,
          ...original,
        });
        expect(
          (await intents(id)).map((row) => json(row.data).dispatchTarget),
        ).toEqual([
          { version: 1, ...original },
          { version: 1, ...original },
        ]);
      });
      for (const reverse of [false, true])
        for (const denied of [false, true]) {
          it(`isolates real failed workers before foreign authorization (reverse=${reverse}, denied=${denied})`, async () => {
            const originalMethod = reverse ? 'otherProcess' : 'process';
            const repairMethod = reverse ? 'process' : 'otherProcess';
            const original = new IngestionService({
              ...options,
              jobTarget: { objectType: workerType, method: originalMethod },
            });
            const result = await original.receive(receive('source-a'));
            expect(result.kind).toBe('accepted');
            if (!('itemId' in result)) throw new Error('Missing receipt');
            const id = result.itemId;
            faults.add('worker:before-process');
            const jobs = await SmrtJobCollection.create({ db });
            const runner = createTaskRunner({
              pollInterval: 20,
              concurrency: 1,
              queues: ['ingestion'],
            });
            try {
              await runner.initialize(db);
              await runner.start();
              await vi.waitFor(
                async () => {
                  const failed = await withTenant({ tenantId: tenant }, () =>
                    jobs.listByStatus('failed', { queue: 'ingestion' }),
                  );
                  expect(failed).toHaveLength(1);
                  expect(failed[0].args.itemId).toBe(id);
                },
                { timeout: 10000, interval: 25 },
              );
            } finally {
              await runner.stop();
            }
            const foreignAuthorization = vi.fn(
              async ({
                capturedCeiling,
              }: Parameters<IngestionOptions['authorize']>[0]) =>
                !denied || capturedCeiling.foreign === true,
            );
            const unrelated = new IngestionService({
              ...options,
              jobTarget: { objectType: workerType, method: repairMethod },
              authorize: foreignAuthorization,
            });
            const input = receive('source-b');
            input.capturedCeiling = { foreign: true };
            expect((await unrelated.receive(input)).kind).toBe('accepted');
            expect(
              foreignAuthorization.mock.calls.every(
                ([call]) => call.capturedCeiling.foreign === true,
              ),
            ).toBe(true);
            expect(Number((await intents(id))[0].deliveries)).toBe(1);
            const pending = await withTenant({ tenantId: tenant }, () =>
              jobs.listByStatus('pending', { queue: 'ingestion' }),
            );
            expect(pending).toHaveLength(1);
            expect(pending[0].method).toBe(repairMethod);
            expect(pending[0].args.itemId).not.toBe(id);
            // The matching host still sees revoked process access, rather than swallowing it.
            const revoked = new IngestionService({
              ...options,
              jobTarget: { objectType: workerType, method: originalMethod },
              authorize: async () => false,
            });
            await expect(revoked.repairDispatches()).rejects.toThrow(
              'unavailable',
            );
            expect(await original.repairDispatches()).toBe(1);
            expect(Number((await intents(id))[0].deliveries)).toBe(2);
          });
        }
      it('rechecks the protected route after authorization and before locked delivery allocation', async () => {
        const id = await accepted('route-snapshot-race');
        await db.query('DELETE FROM _smrt_jobs');
        let changed = false;
        const racing = new IngestionService({
          ...options,
          authorize: async ({ operation, db: executor }) => {
            if (operation === 'process' && executor === db && !changed) {
              changed = true;
              const [item] = (
                await db.query('SELECT data FROM intake_items WHERE id=?', id)
              ).rows;
              await db.query(
                'UPDATE intake_items SET data=? WHERE id=?',
                JSON.stringify({
                  ...json(item.data),
                  dispatchTarget: {
                    version: 1,
                    objectType: workerType,
                    method: 'otherProcess',
                  },
                }),
                id,
              );
            }
            return true;
          },
        });
        expect(await racing.repairDispatches()).toBe(0);
        expect(changed).toBe(true);
        expect(Number((await intents(id))[0].deliveries)).toBe(1);
        expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
          0,
        );
      });
      it('rejects two individually verified but conflicting historical job routes', async () => {
        const id = await accepted('conflicting-exact-lineage');
        await service.analyze(id, {}, 'one');
        await service.analyze(id, {}, 'two');
        const second = (await intents(id))[1];
        const jobs = await SmrtJobCollection.create({ db });
        const job = await withTenant({ tenantId: tenant }, () =>
          jobs.enqueueJob({
            tenantId: tenant,
            objectType: workerType,
            method: 'otherProcess',
            queue: 'ingestion',
            args: { itemId: id, revision: 2, dispatchId: second.id },
          }),
        );
        await db.query(
          'UPDATE intake_dispatches SET job_id=? WHERE id=?',
          job.id,
          second.id,
        );
        await legacy(id, true);
        expect((await service.inspectDispatchRoute(id)).status).toBe(
          'conflict',
        );
        expect(await service.repairDispatches()).toBe(0);
      });
      it('recovers uniquely verified legacy job lineage without trusting the current host', async () => {
        const id = await accepted();
        await legacy(id, true);
        expect((await service.inspectDispatchRoute(id)).status).toBe('bound');
        expect(await service.repairDispatches()).toBe(0);
        expect(
          json(
            (await db.query('SELECT data FROM intake_items WHERE id=?', id))
              .rows[0].data,
          ).dispatchTarget,
        ).toBeDefined();
        const foreign = new IngestionService({
          ...options,
          jobTarget: { objectType: workerType, method: 'otherProcess' },
          authorize: async () => {
            throw new Error('Foreign authorization must not run');
          },
        });
        expect(await foreign.repairDispatches()).toBe(0);
        await expect(
          recovery().recoverDispatchRoute({
            itemId: id,
            expectedFingerprint: (await service.inspectDispatchRoute(id))
              .fingerprint,
            evidenceRef: 'must-not-overwrite',
          }),
        ).rejects.toThrow('conflict');
        await service.analyze(id, {}, 'legacy');
        expect(
          (await intents(id)).every(
            (row) => json(row.data).dispatchTarget !== undefined,
          ),
        ).toBe(true);
      });
      it('refuses conflicting and malformed legacy job lineage without spending delivery budget', async () => {
        for (const mode of ['conflicting', 'malformed', 'malformed-payload']) {
          const id = await accepted(mode);
          await legacy(id, true);
          const [intent] = await intents(id);
          if (mode === 'conflicting') {
            const jobs = await SmrtJobCollection.create({ db });
            const job = await withTenant({ tenantId: tenant }, () =>
              jobs.enqueueJob({
                tenantId: tenant,
                objectType: workerType,
                method: 'otherProcess',
                queue: 'ingestion',
                args: { itemId: id, revision: 2, dispatchId: randomUUID() },
              }),
            );
            await db.query(
              'UPDATE intake_dispatches SET job_id=? WHERE id=?',
              job.id,
              intent.id,
            );
          } else if (mode === 'malformed') {
            await db.query(
              'UPDATE intake_dispatches SET data=? WHERE id=?',
              JSON.stringify({ dispatchTarget: { version: 2 } }),
              intent.id,
            );
          } else {
            await db.query(
              'UPDATE intake_dispatches SET data=? WHERE id=?',
              JSON.stringify('not-a-route-record'),
              intent.id,
            );
          }
          const current = await service.inspectDispatchRoute(id);
          expect(current.status).toBe('conflict');
          await expect(
            recovery().recoverDispatchRoute({
              itemId: id,
              expectedFingerprint: current.fingerprint,
              evidenceRef: mode,
            }),
          ).rejects.toThrow('conflict');
          expect(await service.repairDispatches()).toBe(0);
          expect(Number((await intents(id))[0].deliveries)).toBe(1);
        }
      });
      it('leaves deleted legacy jobs unknown and explicitly recoverable without guessing their route', async () => {
        const id = await accepted('deleted-legacy-job');
        await legacy(id, true);
        await db.query(
          'UPDATE intake_dispatches SET job_id=? WHERE item_id=?',
          randomUUID(),
          id,
        );
        const current = await service.inspectDispatchRoute(id);
        expect(current.status).toBe('unknown');
        expect(await service.repairDispatches()).toBe(0);
        expect(
          (
            await recovery().recoverDispatchRoute({
              itemId: id,
              expectedFingerprint: current.fingerprint,
              evidenceRef: 'operator:deleted-job-review',
            })
          ).status,
        ).toBe('bound');
      });
      it('requires separate recovery authority and current/captured grants, with foreign scope and stale rejection', async () => {
        const { id, input } = await unknown();
        await expect(service.recoverDispatchRoute(input)).rejects.toThrow(
          'unavailable',
        );
        const denied = new IngestionService({
          ...options,
          dispatchRecovery: { authorize: async () => false },
        });
        await expect(denied.recoverDispatchRoute(input)).rejects.toThrow(
          'unavailable',
        );
        allowed = false;
        await expect(recovery().recoverDispatchRoute(input)).rejects.toThrow(
          'unavailable',
        );
        allowed = true;
        const capturedDenied = new IngestionService({
          ...options,
          authorize: async ({ capturedCeiling }) =>
            capturedCeiling.operator === true,
          dispatchRecovery: { authorize: async () => true },
        });
        await expect(
          capturedDenied.recoverDispatchRoute(input),
        ).rejects.toThrow('unavailable');
        for (const scope of [
          { ...options.scope, tenantId: otherTenant },
          { ...options.scope, confidentialScopeId: 'other' },
        ]) {
          const foreign = new IngestionService({
            ...options,
            scope,
            dispatchRecovery: { authorize: async () => true },
          });
          await expect(foreign.recoverDispatchRoute(input)).rejects.toThrow(
            'unavailable',
          );
        }
        await expect(
          recovery().recoverDispatchRoute({
            ...input,
            evidenceRef: 'x'.repeat(513),
          }),
        ).rejects.toThrow('identifier');
        await db.query(
          'UPDATE intake_items SET analysis_revision=1 WHERE id=?',
          id,
        );
        await expect(recovery().recoverDispatchRoute(input)).rejects.toThrow(
          'conflict',
        );
        expect((await service.inspectDispatchRoute(id)).status).toBe('unknown');
      });
      it('rolls recovery back atomically and permits exact concurrent retry without enqueue or authority rewrites', async () => {
        const id = await accepted('original-authority');
        await service.analyze(
          id,
          { provider: 'original-version' },
          'original-analysis',
        );
        await service.createAction(id, 'original-action', {
          original: 'retained',
        });
        await legacy(id);
        const inspected = await service.inspectDispatchRoute(id);
        expect(inspected.status).toBe('unknown');
        const input = {
          itemId: id,
          expectedFingerprint: inspected.fingerprint,
          evidenceRef: 'operator-review:fixture',
        };
        const originalAnalyses = (
          await db.query('SELECT * FROM intake_analyses WHERE item_id=?', id)
        ).rows;
        const originalActions = (
          await db.query('SELECT * FROM intake_actions WHERE item_id=?', id)
        ).rows;
        const originalJobs = (
          await db.query('SELECT id FROM _smrt_jobs ORDER BY id')
        ).rows;
        const before = (
          await db.query('SELECT * FROM intake_items WHERE id=?', id)
        ).rows[0];
        const dispatchBefore = await intents(id);
        faults.add('dispatch:recovered');
        await expect(recovery().recoverDispatchRoute(input)).rejects.toThrow(
          'Injected',
        );
        expect(
          (await db.query('SELECT data FROM intake_items WHERE id=?', id))
            .rows[0].data,
        ).toEqual(before.data);
        expect(await intents(id)).toEqual(dispatchBefore);
        const results = await Promise.all([
          recovery().recoverDispatchRoute(input),
          recovery(peer).recoverDispatchRoute(input),
        ]);
        expect(results[0]).toEqual(results[1]);
        expect(results[0].status).toBe('bound');
        expect(await recovery().recoverDispatchRoute(input)).toEqual(
          results[0],
        );
        await expect(
          recovery().recoverDispatchRoute({
            ...input,
            evidenceRef: 'different-review',
          }),
        ).rejects.toThrow('conflict');
        allowed = false;
        await expect(recovery().recoverDispatchRoute(input)).rejects.toThrow(
          'unavailable',
        );
        allowed = true;
        const after = (
          await db.query('SELECT * FROM intake_items WHERE id=?', id)
        ).rows[0];
        const originalData = json(before.data),
          retained = json(after.data);
        expect(retained).toMatchObject(originalData);
        expect(retained.dispatchRecovery).toMatchObject({
          actorId: 'owner',
          evidenceRef: input.evidenceRef,
          expectedFingerprint: input.expectedFingerprint,
        });
        expect(after.analysis_revision).toBe(before.analysis_revision);
        expect(after.payload_digest).toBe(before.payload_digest);
        expect((await intents(id))[0].deliveries).toBe(
          dispatchBefore[0].deliveries,
        );
        expect((await intents(id))[0].job_id).toBe('');
        expect(
          (await db.query('SELECT * FROM intake_analyses WHERE item_id=?', id))
            .rows,
        ).toEqual(originalAnalyses);
        expect(
          (await db.query('SELECT * FROM intake_actions WHERE item_id=?', id))
            .rows,
        ).toEqual(originalActions);
        expect(
          (await db.query('SELECT id FROM _smrt_jobs ORDER BY id')).rows,
        ).toEqual(originalJobs);
      });
      it('refuses recovery provenance that conflicts with its protected binding', async () => {
        const { id, input } = await unknown();
        await recovery().recoverDispatchRoute(input);
        const [item] = (
          await db.query('SELECT data FROM intake_items WHERE id=?', id)
        ).rows;
        const data = json(item.data);
        data.dispatchRecovery = {
          ...json(data.dispatchRecovery),
          target: {
            version: 1,
            objectType: workerType,
            method: 'otherProcess',
          },
        };
        await db.query(
          'UPDATE intake_items SET data=? WHERE id=?',
          JSON.stringify(data),
          id,
        );
        expect((await service.inspectDispatchRoute(id)).status).toBe(
          'conflict',
        );
        await expect(recovery().recoverDispatchRoute(input)).rejects.toThrow(
          'conflict',
        );
      });
      it('permits only one conflicting recovery decision under the item lock', async () => {
        const { input } = await unknown();
        const results = await Promise.allSettled([
          recovery().recoverDispatchRoute(input),
          recovery(peer).recoverDispatchRoute({
            ...input,
            evidenceRef: 'other-decision',
          }),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === 'rejected'),
        ).toHaveLength(1);
      });
    });
    it('review second regression: ready receipt returns retry when dispatch repair fails', async () => {
      const id = await accepted();
      const retrying = new IngestionService(options);
      retrying.repairDispatches = async () => {
        throw new Error('queue unavailable');
      };
      expect(await retrying.receive(receive())).toEqual({
        kind: 'retry',
        category: 'unavailable',
      });
      expect((await service.getItem(id)).receiptState).toBe('ready');
      expect(await service.getEvidence(id)).toHaveLength(1);
      expect((await service.receive(receive())).kind).toBe('duplicate');
    });
    it('rejects unsafe filenames from direct receive callers and cleans stored names on read (#4214)', async () => {
      // Built from code points: no invisible character appears in source.
      const rlo = String.fromCodePoint(0x202e);
      for (const filename of [
        `invoice${rlo}fdp.exe`,
        'tab\tname.pdf',
        'x'.repeat(513),
        '   ',
      ]) {
        const input = receive(
          `unsafe-${filename.length}-${filename.charCodeAt(4)}`,
        );
        input.parts[0].filename = filename;
        // Rejected as invalid input, never stored.
        expect(await service.receive(input)).toEqual({
          kind: 'rejected',
          category: 'invalid',
        });
      }
      // The same input with a safe name is accepted and stored as given, so
      // the rejections above come from the filename check alone.
      const named = receive('named');
      named.parts[0].filename = 'Acme March.pdf';
      const result = await service.receive(named);
      if (!('itemId' in result)) throw new Error(JSON.stringify(result));
      expect((await service.getEvidence(result.itemId))[0].filename).toBe(
        'Acme March.pdf',
      );
      // A row written outside `receive` (older data, a direct SQL fix) is
      // cleaned on the way out, never surfaced raw.
      for (const [stored, shown] of [
        [`Acme${rlo}fdp.pdf`, 'Acmefdp.pdf'],
        [`${rlo}${String.fromCodePoint(0x200b)}`, undefined],
      ] as const) {
        await db.query(
          'UPDATE intake_evidence SET data=? WHERE item_id=?',
          JSON.stringify({ filename: stored, sourceReference: null }),
          result.itemId,
        );
        expect((await service.getEvidence(result.itemId))[0].filename).toBe(
          shown,
        );
        expect(
          (await service.listEvidence([result.itemId])).get(result.itemId)?.[0]
            .filename,
        ).toBe(shown);
      }
    });
    it('lists a page of durable evidence in one query and omits what the scope cannot read (#4213)', async () => {
      const first = await accepted('page-a');
      const second = await accepted('page-b');
      const unknown = '00000000-0000-4000-8000-000000000000';
      const query = vi.spyOn(db, 'query');
      const page = await service.listEvidence([first, second, unknown]);
      expect(
        query.mock.calls.filter(([sql]) =>
          String(sql).includes('FROM intake_evidence'),
        ),
      ).toHaveLength(1);
      query.mockRestore();
      // An unknown id is omitted, not disclosed.
      expect([...page.keys()].sort()).toEqual([first, second].sort());
      expect(page.get(first)).toEqual(await service.getEvidence(first));
      // Rows of another tenant or confidential scope are never returned, even
      // when that scope's authorization allows everything: the query itself
      // is tenant- and scope-bound.
      for (const scope of [
        { ...options.scope, tenantId: otherTenant },
        { ...options.scope, confidentialScopeId: 'other' },
      ]) {
        const outsider = new IngestionService({
          ...options,
          scope,
          authorize: async () => true,
        });
        expect((await outsider.listEvidence([first, second])).size).toBe(0);
      }
      // A mixed page: one row under a ceiling the host denies is omitted
      // while the readable rows are returned, with one authorization per
      // distinct captured ceiling, not per item.
      const restrictedInput = receive('page-restricted');
      restrictedInput.capturedCeiling = { restricted: true };
      const restrictedResult = await service.receive(restrictedInput);
      if (!('itemId' in restrictedResult))
        throw new Error(JSON.stringify(restrictedResult));
      const restricted = restrictedResult.itemId;
      const ceilingAuthorize = vi.fn(
        async ({
          capturedCeiling,
        }: Parameters<IngestionOptions['authorize']>[0]) =>
          capturedCeiling.restricted !== true,
      );
      const gated = new IngestionService({
        ...options,
        authorize: ceilingAuthorize,
      });
      const mixed = await gated.listEvidence([first, restricted, second]);
      expect([...mixed.keys()].sort()).toEqual([first, second].sort());
      expect(ceilingAuthorize).toHaveBeenCalledTimes(2);
      // Each SQL predicate is needed on its own. A part still at reservation
      // intent (item active) is not listed...
      const intent = await accepted('page-intent');
      await db.query(
        "UPDATE intake_evidence SET state='intent' WHERE item_id=?",
        intent,
      );
      expect((await service.listEvidence([intent])).size).toBe(0);
      // ...nor is a durable part of an item that is no longer active. `expire`
      // also revokes the parts, so the row is set directly to isolate the
      // visibility predicate from the state predicate.
      const inactive = await accepted('page-inactive');
      await db.query(
        "UPDATE intake_items SET visibility='expired' WHERE id=?",
        inactive,
      );
      expect((await service.listEvidence([inactive])).size).toBe(0);
      // A cancelled item stays active and readable, exactly as getEvidence
      // agrees, so its evidence is still listed.
      const cancelled = await accepted('page-cancelled');
      await service.cancel(cancelled);
      expect((await service.listEvidence([cancelled])).get(cancelled)).toEqual(
        await service.getEvidence(cancelled),
      );
      // A denied ceiling omits the rows; so does an expired item.
      allowed = false;
      expect((await service.listEvidence([first])).size).toBe(0);
      allowed = true;
      const now = clock;
      clock = new Date(now.getTime() + 100001);
      expect((await service.listEvidence([first])).size).toBe(0);
      clock = now;
      // A failing host authorization surfaces instead of hiding evidence.
      const failing = new IngestionService({
        ...options,
        authorize: async () => {
          throw new Error('authorization store down');
        },
      });
      await expect(failing.listEvidence([first])).rejects.toThrow(
        'authorization store down',
      );
      // A malformed captured ceiling hides that item, as on a list page,
      // instead of rejecting the read; the other item is still returned.
      const stored = (
        await db.query('SELECT data FROM intake_items WHERE id=?', first)
      ).rows[0].data;
      const malformed =
        typeof stored === 'string'
          ? JSON.parse(stored)
          : structuredClone(stored);
      malformed.capturedCeiling = 5;
      await db.query(
        'UPDATE intake_items SET data=? WHERE id=?',
        JSON.stringify(malformed),
        first,
      );
      const withMalformed = await service.listEvidence([first, second]);
      expect(withMalformed.has(first)).toBe(false);
      expect(withMalformed.has(second)).toBe(true);
      expect(
        (await service.listItemsPage()).items.map(({ item }) => item.id),
      ).not.toContain(first);
      await db.query(
        'UPDATE intake_items SET data=? WHERE id=?',
        typeof stored === 'string' ? stored : JSON.stringify(stored),
        first,
      );
      expect((await service.listEvidence([first])).has(first)).toBe(true);
      // Item data that does not parse as an object (an array here, which
      // both engines store) is skipped by both list paths, not fatal.
      await db.query(
        'UPDATE intake_items SET data=? WHERE id=?',
        JSON.stringify([]),
        first,
      );
      const unparsable = await service.listEvidence([first, second]);
      expect(unparsable.has(first)).toBe(false);
      expect(unparsable.has(second)).toBe(true);
      const unparsablePage = (await service.listItemsPage()).items.map(
        ({ item }) => item.id,
      );
      expect(unparsablePage).not.toContain(first);
      expect(unparsablePage).toContain(second);
      await db.query(
        'UPDATE intake_items SET data=? WHERE id=?',
        typeof stored === 'string' ? stored : JSON.stringify(stored),
        first,
      );
      expect((await service.listEvidence([first])).has(first)).toBe(true);
      // Bounded, validated input.
      expect((await service.listEvidence([])).size).toBe(0);
      await expect(service.listEvidence(['not-a-uuid'])).rejects.toThrow(
        'Invalid item page',
      );
      await expect(
        service.listEvidence(Array.from({ length: 101 }, () => unknown)),
      ).rejects.toThrow('Invalid item page');
    });
    for (const operation of ['cancel', 'expire'] as const)
      it(`review second regression: ${operation} terminates queued and running parent analyses`, async () => {
        for (const running of [false, true]) {
          const id = await accepted(String(running));
          const revision = await service.analyze(id, {}, 'analysis');
          const lease = running
            ? await service.claimAnalysis(id, revision.revision, 'worker')
            : null;
          await service[operation](id);
          expect(
            (
              await db.query(
                'SELECT state FROM intake_analyses WHERE item_id=?',
                id,
              )
            ).rows,
          ).toEqual([expect.objectContaining({ state: 'superseded' })]);
          expect(
            (
              await db.query(
                "SELECT state FROM intake_analysis_attempts WHERE item_id=? AND state IN ('queued','running')",
                id,
              )
            ).rows,
          ).toHaveLength(0);
          if (lease) {
            if (operation === 'expire')
              await expect(
                service.completeAnalysis(lease, output),
              ).rejects.toThrow('unavailable');
            else
              expect(await service.completeAnalysis(lease, output)).toBe(false);
          }
        }
      });
    it('review second regression: retention sweep repairs each tombstone once', async () => {
      const old = await accepted('old');
      await service.expire(old);
      await accepted('new1');
      await accepted('new2');
      clock = new Date(clock.getTime() + 100001);
      const original = options.assets.store.removeFile.bind(
        options.assets.store,
      );
      let removals = 0;
      options.assets.store.removeFile = async (asset) => {
        removals++;
        return original(asset);
      };
      expect(await service.sweepRetention()).toBe(2);
      // Two live owners plus the three retained cleanup locators.
      expect(removals).toBe(5);
      expect(purges).toBe(3);
      removals = 0;
      expect(await service.sweepRetention()).toBe(0);
      expect(removals).toBe(3);
    });
    it('review third regression: denied expiry still cleans earlier scheduled receipts', async () => {
      for (const key of ['first', 'second']) {
        const input = receive(key);
        input.capturedCeiling = { key };
        expect((await service.receive(input)).kind).toBe('accepted');
      }
      const items = (await db.query('SELECT id,data FROM intake_items')).rows;
      // SQL row order is not a contract (route pinning can move PG tuples).
      // Deny the second distinct key actually visited by this sweep.
      let permittedKey: unknown;
      const evidence = (
        await db.query('SELECT item_id,source_uri FROM intake_evidence')
      ).rows;
      const filenames = new Map(
        evidence.map((row) => [
          String(row.item_id),
          fileURLToPath(String(row.source_uri)),
        ]),
      );
      const failure = new Error('delete grant revoked');
      const sweeping = new IngestionService({
        ...options,
        authorize: async ({ operation, capturedCeiling }) => {
          if (operation === 'delete') {
            permittedKey ??= capturedCeiling.key;
            if (capturedCeiling.key !== permittedKey) throw failure;
          }
          return true;
        },
      });
      clock = new Date(clock.getTime() + 100001);
      await expect(sweeping.sweepRetention()).rejects.toBe(failure);
      const permitted = items.find(
        (item) =>
          (typeof item.data === 'string' ? JSON.parse(item.data) : item.data)
            .capturedCeiling.key === permittedKey,
      )!;
      const denied = items.find((item) => item.id !== permitted.id)!;
      await expect(
        readFile(filenames.get(String(permitted.id))!),
      ).rejects.toThrow();
      expect(await readFile(filenames.get(String(denied.id))!, 'utf8')).toBe(
        'retained original',
      );
      expect(purges).toBe(1);
      expect(
        (
          await db.query(
            'SELECT visibility FROM intake_items WHERE id=?',
            denied.id,
          )
        ).rows[0].visibility,
      ).toBe('active');
      expect(
        (
          await db.query(
            'SELECT state FROM intake_deletions WHERE item_id=?',
            permitted.id,
          )
        ).rows[0].state,
      ).toBe('completed');
      expect(
        (
          await db.query(
            'SELECT id FROM intake_deletions WHERE item_id=?',
            denied.id,
          )
        ).rows,
      ).toHaveLength(0);
      await expect(sweeping.sweepRetention()).rejects.toBe(failure);
      expect(purges).toBe(1);
    });
    it('review regression: reauthorizes receipt reservation on its owning transaction', async () => {
      let granted = true;
      const receiveExecutors: DatabaseInterface[] = [];
      const receiving = new IngestionService({
        ...options,
        authorize: async ({ operation, db: executor }) => {
          if (operation !== 'receive') return granted;
          receiveExecutors.push(executor);
          const result = granted;
          granted = false; // Revoked after the initial check, before reservation.
          return result;
        },
      });
      let failure: unknown;
      try {
        await receiving.receive(receive('revoked-at-reservation'));
      } catch (error) {
        failure = error;
      }
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS n FROM intake_items')).rows[0].n,
        ),
      ).toBe(0);
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS n FROM intake_evidence')).rows[0]
            .n,
        ),
      ).toBe(0);
      expect(failure).toBeInstanceOf(Error);
      expect(receiveExecutors).toHaveLength(2);
      expect(receiveExecutors[0]).toBe(db);
      expect(receiveExecutors[1]).not.toBe(db);
    });

    it('review regression: repair cannot replace completion from a stale dispatch snapshot', async () => {
      const id = await accepted('repair-completion-race');
      const lease = await analysis(id);
      await db.query('DELETE FROM _smrt_jobs');
      let completed = false;
      const repairing = new IngestionService({
        ...options,
        authorize: async ({ operation, db: executor }) => {
          // repair has loaded its dispatch snapshot and is reading the item,
          // but has not acquired its allocation transaction yet.
          if (operation === 'process' && executor === db && !completed) {
            completed = true;
            expect(await service.completeAnalysis(lease, output)).toBe(true);
          }
          return true;
        },
      });
      expect(await repairing.repairDispatches()).toBe(0);
      expect(completed).toBe(true);
      expect((await service.getItem(id)).processingState).toBe('completed');
      expect(
        (
          await db.query(
            'SELECT state FROM intake_dispatches WHERE item_id=?',
            id,
          )
        ).rows[0].state,
      ).toBe('completed');
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS n FROM _smrt_jobs')).rows[0].n,
        ),
      ).toBe(0);
    });

    it('review regression: reanalysis retires obsolete dispatches and repair ignores old revisions', async () => {
      const id = await accepted('repair-supersession');
      const first = await analysis(id);
      const second = await service.analyze(
        id,
        { provider: 'replacement' },
        'replacement',
      );
      const lease = await service.claimAnalysis(
        id,
        second.revision,
        'replacement-worker',
      );
      expect(lease).toBeTruthy();
      expect(await service.completeAnalysis(lease!, output)).toBe(true);
      expect(
        (
          await db.query(
            'SELECT state FROM intake_dispatches WHERE item_id=? AND revision=?',
            id,
            first.revision,
          )
        ).rows[0].state,
      ).toBe('completed');
      // A pre-fix obsolete intent may still be active; repair must retire it
      // without enqueueing or projecting its exhausted budget onto revision 2.
      await db.query(
        "UPDATE intake_dispatches SET state='pending',deliveries=2,job_id='' WHERE item_id=? AND revision=?",
        id,
        first.revision,
      );
      await db.query('DELETE FROM _smrt_jobs');
      expect(await service.repairDispatches()).toBe(0);
      expect(await service.getItem(id)).toMatchObject({
        analysisRevision: 2,
        processingState: 'completed',
      });
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS n FROM _smrt_jobs')).rows[0].n,
        ),
      ).toBe(0);
      expect(
        (
          await db.query(
            'SELECT state FROM intake_dispatches WHERE item_id=? AND revision=?',
            id,
            first.revision,
          )
        ).rows[0].state,
      ).toBe('completed');
    });

    it('review regression: final expired analysis lease projects needs-attention atomically', async () => {
      const id = await accepted('exhausted-lease');
      const first = await analysis(id);
      clock = new Date(clock.getTime() + 101);
      const last = await service.claimAnalysis(
        id,
        first.revision,
        'last-worker',
      );
      expect(last).toBeTruthy();
      clock = new Date(clock.getTime() + 101);
      expect(
        await service.claimAnalysis(id, first.revision, 'exhausted-worker'),
      ).toBeNull();
      expect((await service.getItem(id)).processingState).toBe(
        'needs_attention',
      );
      expect(
        (
          await db.query(
            'SELECT state FROM intake_analyses WHERE id=?',
            first.analysisId,
          )
        ).rows[0].state,
      ).toBe('needs_attention');
      expect(
        (
          await db.query(
            'SELECT state,safe_error FROM intake_analysis_attempts WHERE id=?',
            last!.attemptId,
          )
        ).rows[0],
      ).toMatchObject({ state: 'needs_attention', safe_error: 'limit' });
      expect(
        (
          await db.query(
            'SELECT state FROM intake_dispatches WHERE item_id=? AND revision=?',
            id,
            first.revision,
          )
        ).rows[0].state,
      ).toBe('completed');
      expect(await service.completeAnalysis(last!, output)).toBe(false);
    });

    it('preserves originals, relationships, idempotent replay and separate equal-byte arrivals', async () => {
      const input = receive();
      input.parts.push({
        partId: 'attachment',
        parentPartId: 'message',
        mediaType: 'text/plain',
        bytes: Buffer.from('attached'),
      });
      const first = await service.receive(input);
      expect(first.kind).toBe('accepted');
      if (!('itemId' in first)) throw new Error('receipt');
      expect(await service.receive(input)).toEqual({
        ...first,
        kind: 'duplicate',
      });
      const evidence = await service.getEvidence(first.itemId);
      expect(evidence).toHaveLength(2);
      expect(
        evidence.find((e) => e.partId === 'attachment')?.parentEvidenceId,
      ).toBe(evidence.find((e) => e.partId === 'message')?.id);
      expect(
        Buffer.from(
          await service.readEvidence(
            first.itemId,
            evidence.find((e) => e.partId === 'message')!.id,
          ),
        ).toString(),
      ).toBe('retained original');
      expect(await accepted('other-conversation')).not.toBe(first.itemId);
      expect(
        await service.receive({
          ...input,
          parts: [{ ...input.parts[0], bytes: Buffer.from('changed') }],
        }),
      ).toEqual({ kind: 'rejected', category: 'conflict' });
    });
    it('serializes concurrent receipt reservations across real connections', async () => {
      const second = new IngestionService({
        ...options,
        db: peer,
        assets: await createAssetRuntime({
          db: peer,
          storage: join(root, 'assets'),
        }),
      });
      const results = await Promise.all([
        service.receive(receive()),
        second.receive(receive()),
      ]);
      expect(results.some((r) => r.kind === 'accepted')).toBe(true);
      const replay = await service.receive(receive());
      expect(replay.kind).toBe('duplicate');
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS n FROM intake_items')).rows[0].n,
        ),
      ).toBe(1);
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS n FROM intake_evidence')).rows[0]
            .n,
        ),
      ).toBe(1);
    });
    for (const point of [
      'reserved',
      'storage_intent',
      'storage',
      'evidence',
      'ready',
      'enqueued',
      'ack',
    ])
      it(`recovers interruption at ${point}`, async () => {
        const input = receive();
        faults.add(point);
        try {
          await service.receive(input);
        } catch {
          /* simulated death before return */
        }
        clock = new Date(clock.getTime() + 101);
        const recovered = await service.receive(input);
        expect(['accepted', 'duplicate']).toContain(recovered.kind);
        if (!('itemId' in recovered))
          throw new Error(JSON.stringify(recovered));
        expect(await service.getEvidence(recovered.itemId)).toHaveLength(1);
        expect(
          Number(
            (await db.query('SELECT COUNT(*) AS n FROM intake_items')).rows[0]
              .n,
          ),
        ).toBe(1);
        expect(
          Number(
            (await db.query('SELECT COUNT(*) AS n FROM assets')).rows[0].n,
          ),
        ).toBe(1);
        expect(
          Number(
            (
              await db.query(
                "SELECT COUNT(*) AS n FROM intake_dispatches WHERE state='delivered'",
              )
            ).rows[0].n,
          ),
        ).toBe(1);
      });
    for (const boundary of ['reserved', 'storage', 'ready', 'enqueued'])
      it(`survives actual process death at ${boundary}`, async () => {
        const input = receive('crashed');
        const child = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL('../../scripts/crash-receipt.mjs', import.meta.url),
            ),
          ],
          {
            env: {
              ...process.env,
              INGESTION_CRASH_DB: db.url,
              INGESTION_CRASH_CONFIG: JSON.stringify({
                dialect,
                input: {
                  ...input,
                  parts: input.parts.map((p) => ({
                    ...p,
                    bytes: [...p.bytes],
                  })),
                },
                storage: join(root, 'assets'),
                scope: options.scope,
                jobTarget: options.jobTarget,
                now: clock,
                boundary,
              }),
            },
            encoding: 'utf8',
            timeout: 20000,
          },
        );
        expect(child.status).toBe(73);
        clock = new Date(clock.getTime() + 101);
        const recovered = await service.receive(input);
        expect(recovered.kind).toBe('duplicate');
        if (!('itemId' in recovered)) throw new Error('recovery');
        const originals = await service.getEvidence(recovered.itemId);
        expect(originals).toHaveLength(1);
        expect(
          Buffer.from(
            await service.readEvidence(recovered.itemId, originals[0].id),
          ).toString(),
        ).toBe('retained original');
        expect(
          Number(
            (await db.query('SELECT COUNT(*) AS n FROM intake_items')).rows[0]
              .n,
          ),
        ).toBe(1);
      });
    it('repairs deleted queue rows and deduplicates stage claims', async () => {
      const id = await accepted();
      await db.query('DELETE FROM _smrt_jobs');
      expect(await service.repairDispatches()).toBe(1);
      const a = await service.analyze(id, {}, 'start');
      const second = new IngestionService({ ...options, db: peer });
      const leases = await Promise.all([
        service.claimAnalysis(id, a.revision, 'a'),
        second.claimAnalysis(id, a.revision, 'b'),
      ]);
      expect(leases.filter(Boolean)).toHaveLength(1);
      expect(
        await service.completeAnalysis(leases.find(Boolean)!, output),
      ).toBe(true);
      expect(
        await service.completeAnalysis(leases.find(Boolean)!, output),
      ).toBe(false);
      expect(await service.repairDispatches()).toBe(0);
    });
    it('fences late workers, preserves retry provenance, and enforces budgets', async () => {
      const id = await accepted();
      const first = await analysis(id);
      clock = new Date(clock.getTime() + 101);
      const second = await service.claimAnalysis(
        id,
        first.revision,
        'new-worker',
      );
      expect(second?.fence).toBe(first.fence + 1);
      expect(await service.completeAnalysis(first, output)).toBe(false);
      expect(
        await service.completeAnalysis(second!, {
          ...output,
          status: 'failed',
          error: 'timeout',
        }),
      ).toBe(true);
      expect(
        await service.claimAnalysis(id, first.revision, 'exhausted'),
      ).toBeNull();
      const attempts = (
        await db.query(
          'SELECT state,confidence,data FROM intake_analysis_attempts ORDER BY attempt_number',
        )
      ).rows;
      expect(attempts.map((a) => a.state)).toEqual(['superseded', 'failed']);
      expect(Number(attempts[1].confidence)).toBe(0.875);
      expect(
        (await db.query('SELECT state FROM intake_analyses')).rows[0].state,
      ).toBe('needs_attention');
    });
    it('reanalysis appends revisions without minting or replacing intended actions', async () => {
      const id = await accepted();
      const lease = await analysis(id);
      await service.completeAnalysis(lease, output);
      const action = await service.createAction(id, 'draft', {
        intent: 'create draft',
      });
      expect(
        await service.createAction(id, 'draft', { intent: 'create draft' }),
      ).toBe(action);
      const proposal = await service.publishProposal({
        itemId: id,
        actionId: action,
        attemptId: lease.attemptId,
        expectedRevision: 0,
        binding: { args: { title: 'draft' }, handler: 'draft@1' },
      });
      expect(proposal.revision).toBe(1);
      const plan = await service.appendPlan(
        id,
        'plan',
        1,
        [{ actionId: action, proposalRevision: 1 }],
        { definitionHash: 'frozen' },
      );
      expect(
        await service.appendPlan(
          id,
          'plan',
          1,
          [{ actionId: action, proposalRevision: 1 }],
          { definitionHash: 'frozen' },
        ),
      ).toBe(plan);
      const revision = await service.analyze(
        id,
        { provider: 'new' },
        'reprocess',
      );
      expect(revision.revision).toBe(2);
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS n FROM intake_actions')).rows[0]
            .n,
        ),
      ).toBe(1);
      await expect(
        service.publishProposal({
          itemId: id,
          actionId: action,
          attemptId: lease.attemptId,
          expectedRevision: 0,
          binding: {},
        }),
      ).rejects.toThrow('conflict');
      await db.query(
        "UPDATE intake_actions SET state='succeeded',result_digest='original' WHERE id=?",
        action,
      );
      await expect(
        service.publishProposal({
          itemId: id,
          actionId: action,
          attemptId: lease.attemptId,
          expectedRevision: 1,
          binding: {},
        }),
      ).rejects.toThrow('conflict');
    });
    it('lists a reprocessing item as processing despite older saved actions', async () => {
      const id = await accepted('page-reprocessing');
      const action = await service.createAction(id, 'prior-action', {});
      for (const processing of ['queued', 'running']) {
        await db.query(
          'UPDATE intake_items SET processing_state=? WHERE id=?',
          processing,
          id,
        );
        for (const priorState of ['succeeded', 'deferred']) {
          await db.query(
            'UPDATE intake_actions SET state=? WHERE id=?',
            priorState,
            action,
          );
          const page = await service.listItemsPage({
            itemIds: [id],
            state: 'processing',
          });
          expect(page.items.map((row) => [row.item.id, row.state])).toEqual([
            [id, 'processing'],
          ]);
          expect(
            (
              await service.listItemsPage({
                itemIds: [id],
                state: priorState === 'succeeded' ? 'completed' : 'deferred',
              })
            ).items,
          ).toEqual([]);
        }
      }
    });
    it('pages the inbox newest-first with query-side filters, bounded authorization and page-proportional queries', async () => {
      const seed = await accepted('page-seed');
      const [template] = (
        await db.query('SELECT * FROM intake_items WHERE id=?', seed)
      ).rows as Array<Record<string, unknown>>;
      const base = Date.parse('2026-10-01T00:00:00.000Z');
      type Seeded = { id: string; receivedAt: string; expected: string };
      const seeded: Seeded[] = [];
      const columns = Object.keys(template);
      const secret = { handlers: ['secret'] };
      // Trusted test setup copies the accepted row so paging is measured over
      // hundreds of items without hundreds of receipts. Every 60th row carries
      // a ceiling the actor may not read; every 50th row has a saved action.
      async function seedRows(
        count: number,
        receivedAt: (index: number) => string,
      ) {
        const pendingRows: unknown[][] = [];
        const pendingActions: number[] = [];
        const flush = async () => {
          if (!pendingRows.length) return;
          await db.query(
            `INSERT INTO intake_items (${columns.join(',')}) VALUES ${pendingRows
              .map(() => `(${columns.map(() => '?').join(',')})`)
              .join(',')}`,
            ...pendingRows.flat(),
          );
          pendingRows.length = 0;
        };
        const first = seeded.length;
        for (let index = first; index < first + count; index++) {
          const id = randomUUID();
          const data = JSON.parse(
            typeof template.data === 'string'
              ? template.data
              : JSON.stringify(template.data),
          );
          const hidden = index % 60 === 5;
          if (hidden) data.capturedCeiling = secret;
          seeded.push({
            id,
            receivedAt: receivedAt(index),
            expected: hidden
              ? 'hidden'
              : index % 50 === 7
                ? 'deferred'
                : index % 50 === 9
                  ? 'completed'
                  : index % 10 === 0
                    ? 'failed'
                    : 'processing',
          });
          const row: Record<string, unknown> = {
            ...template,
            id,
            slug: id,
            delivery_key: `page-${index}`,
            created_at: receivedAt(index),
            updated_at: receivedAt(index),
            processing_state:
              index % 50 === 7 || index % 50 === 9
                ? 'completed'
                : index % 10 === 0
                  ? 'needs_attention'
                  : String(template.processing_state),
            data: JSON.stringify(data),
          };
          pendingRows.push(columns.map((column) => row[column]));
          if (pendingRows.length === 50) await flush();
          if (index % 50 === 7 || index % 50 === 9) pendingActions.push(index);
        }
        await flush();
        for (const index of pendingActions)
          await db.query(
            "INSERT INTO intake_actions (id,slug,context,tenant_id,confidential_scope_id,item_id,action_key,state,proposal_revision,review_version,execution_attempt,fence,result_digest,data) VALUES (?,?,'',?,?,?,?,?,1,0,0,0,'','{}')",
            randomUUID(),
            randomUUID(),
            tenant,
            'confidential',
            seeded[index].id,
            `page-${index}`,
            index % 50 === 7 ? 'deferred' : 'succeeded',
          );
      }
      // The newest two share a timestamp to exercise the id tiebreak.
      await seedRows(300, (index) =>
        new Date(base + Math.min(index, 298) * 1000).toISOString(),
      );
      await db.query('DELETE FROM intake_items WHERE id=?', seed);
      // Newest first: later index first, equal timestamps broken by id descending.
      const sorted = () =>
        [...seeded].sort(
          (a, b) =>
            b.receivedAt.localeCompare(a.receivedAt) ||
            b.id.localeCompare(a.id),
        );
      let ordered = sorted();
      let visible = ordered.filter((row) => row.expected !== 'hidden');
      let queries = 0;
      let authorizations = 0;
      let lastPage: { sql: string; params: unknown[] } | undefined;
      const counted = new Proxy(db, {
        get(target, property) {
          if (property === 'query')
            return (...args: unknown[]) => {
              queries++;
              if (String(args[0]).includes('FROM intake_items i'))
                lastPage = { sql: String(args[0]), params: args.slice(1) };
              return (target.query as (...a: unknown[]) => unknown)(...args);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const isSecret = (ceiling: unknown) =>
        JSON.stringify(ceiling) === JSON.stringify(secret);
      const paged = new IngestionService({
        ...options,
        db: counted,
        authorize: async (input) => {
          authorizations++;
          if (isSecret(input.capturedCeiling)) return false;
          return options.authorize(input);
        },
      });
      const ids = (page: Awaited<ReturnType<typeof paged.listItemsPage>>) =>
        page.items.map(({ item }) => item.id);

      queries = authorizations = 0;
      const first = await paged.listItemsPage();
      expect(ids(first)).toEqual(visible.slice(0, 20).map((row) => row.id));
      expect(first.nextCursor).toBeTruthy();
      expect(queries).toBe(1);
      expect(authorizations).toBe(1);

      queries = authorizations = 0;
      const wide = await paged.listItemsPage({ limit: 100 });
      expect(ids(wide)).toEqual(visible.slice(0, 100).map((row) => row.id));
      expect(wide.items.map(({ state }) => state)).toEqual(
        visible.slice(0, 100).map((row) => row.expected),
      );
      // Two distinct captured ceilings in the page: one allow, one deny.
      // Denied rows refill from the next rows with one more page read; rows
      // with saved actions add one handler-binding read per batch.
      expect(authorizations).toBe(2);
      const wideQueries = queries;
      expect(wideQueries).toBeLessThanOrEqual(4);

      const walked: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await paged.listItemsPage({ limit: 100, cursor });
        walked.push(...ids(page));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(walked).toEqual(visible.map((row) => row.id));
      expect(new Set(walked).size).toBe(visible.length);
      // The deprecated array API is the same walk.
      expect((await paged.listItems()).map((item) => item.id)).toEqual(walked);

      const tie = await paged.listItemsPage({ limit: 1 });
      const tied = await paged.listItemsPage({
        limit: 1,
        cursor: tie.nextCursor,
      });
      expect([...ids(tie), ...ids(tied)]).toEqual(
        visible.slice(0, 2).map((row) => row.id),
      );
      expect(ordered[0].receivedAt).toBe(ordered[1].receivedAt);

      for (const input of [
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { cursor: 'not-a-cursor' },
        { cursor: Buffer.from('["x","y"]').toString('base64url') },
        { state: 'bogus' as never },
        { itemIds: ['forged'] },
      ])
        await expect(paged.listItemsPage(input)).rejects.toThrow(
          'Invalid item page',
        );

      const failed = visible.filter((row) => row.expected === 'failed');
      queries = 0;
      const failedPage = await paged.listItemsPage({
        state: 'failed',
        limit: 20,
      });
      expect(ids(failedPage)).toEqual(failed.slice(0, 20).map((row) => row.id));
      expect(failedPage.nextCursor).toBeTruthy();
      // The state filter runs on fetched batches (20, 20, 40, 80, 100 rows)
      // after authorization, with one binding read per batch holding action
      // rows, so a rare state is bounded by the scan limit like any other
      // filter.
      const failedQueries = queries;
      expect(failedQueries).toBeLessThanOrEqual(10);
      const failedRest = await paged.listItemsPage({
        state: 'failed',
        limit: 20,
        cursor: failedPage.nextCursor,
      });
      expect(ids(failedRest)).toEqual(failed.slice(20).map((row) => row.id));
      expect(failedRest.nextCursor).toBeUndefined();
      for (const state of ['deferred', 'completed'] as const) {
        const page = await paged.listItemsPage({ state });
        expect(ids(page)).toEqual(
          visible.filter((row) => row.expected === state).map((row) => row.id),
        );
        expect(page.nextCursor).toBeUndefined();
      }
      expect((await paged.listItemsPage({ state: 'waiting' })).items).toEqual(
        [],
      );

      const chosen = [
        visible[250].id,
        visible[3].id,
        ordered.find((r) => r.expected === 'hidden')?.id ?? '',
      ];
      expect(ids(await paged.listItemsPage({ itemIds: chosen }))).toEqual([
        visible[3].id,
        visible[250].id,
      ]);
      expect(await paged.listItemsPage({ itemIds: [] })).toMatchObject({
        items: [],
      });

      const outsider = new IngestionService({
        ...options,
        scope: { ...options.scope, confidentialScopeId: 'other' },
      });
      expect(await outsider.listItemsPage({ limit: 100 })).toMatchObject({
        items: [],
      });

      // Five times the items, all older: the same pages cost the same queries.
      await seedRows(1200, (index) =>
        new Date(base - (index - 299) * 1000).toISOString(),
      );
      ordered = sorted();
      visible = ordered.filter((row) => row.expected !== 'hidden');
      expect(seeded).toHaveLength(1500);
      queries = authorizations = 0;
      expect(ids(await paged.listItemsPage())).toEqual(ids(first));
      expect(queries).toBe(1);
      expect(authorizations).toBe(1);
      queries = 0;
      expect(ids(await paged.listItemsPage({ limit: 100 }))).toEqual(ids(wide));
      expect(queries).toBe(wideQueries);
      queries = 0;
      expect(
        ids(await paged.listItemsPage({ state: 'failed', limit: 20 })),
      ).toEqual(ids(failedPage));
      expect(queries).toBe(failedQueries);

      // Rows are authorized before the state filter, so a readable row whose
      // state does not match anchors the cursor: with an actor who can read
      // every row, every state filter pages to the end without failing,
      // including states with no match among the newest thousand rows.
      const full = new IngestionService({ ...options, db: counted });
      const actual = (row: Seeded) =>
        row.expected === 'hidden' ? 'processing' : row.expected;
      for (const state of [
        'processing',
        'unresolved',
        'waiting',
        'failed',
        'deferred',
        'partially_completed',
        'completed',
      ] as const) {
        const found: string[] = [];
        let at: string | undefined;
        let calls = 0;
        do {
          const page = await full.listItemsPage({
            state,
            limit: 20,
            cursor: at,
          });
          found.push(...ids(page));
          at = page.nextCursor;
          calls++;
          expect(calls).toBeLessThan(200);
        } while (at);
        expect(found).toEqual(
          ordered.filter((row) => actual(row) === state).map((row) => row.id),
        );
      }
      // The filter is applied to fetched batches, not inside the query: a
      // state with no match scans the full limit and hands back a cursor at
      // a readable row, where an in-query filter would walk every row.
      const none = await full.listItemsPage({ state: 'waiting', limit: 20 });
      expect(none.items).toEqual([]);
      expect(none.scanned).toBe(1000);
      expect(none.nextCursor).toBeTruthy();

      // Plan evidence: the unfiltered page walks intake_items_received_idx
      // backwards and stops at the page boundary; no sort, no table scan.
      // The per-row state counters use intake_actions_item_idx.
      await paged.listItemsPage();
      expect(lastPage).toBeTruthy();
      if (dialect === 'sqlite') {
        // No planner statistics: the plan must come from the pinned index,
        // not from ANALYZE output a deployment may never produce.
        expect(
          (
            await db.query(
              "SELECT name FROM sqlite_master WHERE name='sqlite_stat1'",
            )
          ).rows,
        ).toEqual([]);
        const plan = (
          await db.query(
            `EXPLAIN QUERY PLAN ${lastPage!.sql}`,
            ...lastPage!.params,
          )
        ).rows.map((row) => String(row.detail));
        expect(plan).toEqual(
          expect.arrayContaining([
            expect.stringContaining('USING INDEX intake_items_received_idx'),
            expect.stringContaining('USING INDEX intake_actions_item_idx'),
          ]),
        );
        expect(plan.some((line) => /TEMP B-TREE FOR ORDER BY/.test(line))).toBe(
          false,
        );
        expect(
          plan.some(
            (line) =>
              /^SCAN (i|intake_items)\b/.test(line) && !line.includes('USING'),
          ),
        ).toBe(false);
      } else {
        await db.query('ANALYZE intake_items');
        await db.query('ANALYZE intake_actions');
        const plan = (
          await db.query(`EXPLAIN ${lastPage!.sql}`, ...lastPage!.params)
        ).rows
          .map((row) => String(row['QUERY PLAN']))
          .join('\n');
        expect(plan).toContain(
          'Index Scan Backward using intake_items_received_idx',
        );
        expect(plan).not.toContain('Seq Scan on intake_items');
        expect(plan).not.toMatch(/^\s*->\s+Sort/m);
      }

      const rare = new IngestionService({
        ...options,
        db: counted,
        authorize: async (input) => isSecret(input.capturedCeiling),
      });
      // A receipt time the service never wrote (only SQLite can hold such
      // text in a datetime column) is skipped and counted like a denied row.
      // A call returns what it collected with a cursor at the last good row;
      // only a call that read nothing but such rows fails, and its message
      // names no row.
      if (dialect === 'sqlite') {
        const setTime = (id: string, value: string) =>
          db.query(
            'UPDATE intake_items SET created_at=? WHERE id=?',
            value,
            id,
          );
        const corrupt = visible[5].id;
        // Text that sorts beside the row's real position but is not a time.
        await setTime(corrupt, `${visible[5].receivedAt}x`);
        const good = visible.filter((row) => row.id !== corrupt);
        const skipped = await paged.listItemsPage();
        expect(ids(skipped)).toEqual(good.slice(0, 20).map((row) => row.id));
        expect(skipped.scanned).toBe(21);
        // The batch ends on the corrupt row after five good ones: the five
        // come back with a cursor instead of being discarded.
        const partial = await paged.listItemsPage({ limit: 20, scanLimit: 6 });
        expect(ids(partial)).toEqual(good.slice(0, 5).map((row) => row.id));
        expect(partial.scanned).toBe(6);
        expect(partial.nextCursor).toBeTruthy();
        // The next call starts on the corrupt row: with a one-row budget it
        // makes no progress and fails without naming the row; with a normal
        // budget it passes the row and continues.
        await expect(
          paged.listItemsPage({
            limit: 20,
            scanLimit: 1,
            cursor: partial.nextCursor,
          }),
        ).rejects.toThrow(/^Intake scan limit$/);
        const resumed = await paged.listItemsPage({
          limit: 20,
          cursor: partial.nextCursor,
        });
        expect(ids(resumed)).toEqual(good.slice(5, 25).map((row) => row.id));
        // A run of 130 such rows is passed within one call by its raw stored
        // text, not re-read on every refill.
        const run = ordered.slice(10, 140);
        for (const row of run) await setTime(row.id, `${row.receivedAt}x`);
        const inRun = new Set(run.map((row) => row.id));
        queries = 0;
        const pastRun = await paged.listItemsPage({ limit: 20 });
        expect(ids(pastRun)).toEqual(
          good
            .filter((row) => !inRun.has(row.id))
            .slice(0, 20)
            .map((row) => row.id),
        );
        expect(pastRun.scanned).toBeLessThan(200);
        expect(queries).toBeLessThanOrEqual(12);
        for (const row of [...run, visible[5]])
          await setTime(row.id, row.receivedAt);
        expect(ids(await paged.listItemsPage())).toEqual(ids(first));
        // An integer receipt value sorts after every text value on SQLite and
        // always satisfies `created_at < ?`; such rows are excluded from the
        // page query, so neither a keyed nor an unkeyed walk can stall.
        const ints = ordered.slice(200, 350);
        for (const row of ints)
          await db.query(
            'UPDATE intake_items SET created_at=? WHERE id=?',
            1,
            row.id,
          );
        expect(
          (
            await db.query(
              'SELECT typeof(created_at) AS kind FROM intake_items WHERE id=?',
              ints[0].id,
            )
          ).rows[0].kind,
        ).toBe('integer');
        const inInts = new Set(ints.map((row) => row.id));
        const expectedAll = ordered
          .filter((row) => !inInts.has(row.id))
          .map((row) => row.id);
        for (const walker of [
          full,
          new IngestionService({
            ...options,
            db: counted,
            cursorKey: 'k'.repeat(32),
          }),
        ]) {
          const walked: string[] = [];
          let at: string | undefined;
          let calls = 0;
          do {
            const page = await walker.listItemsPage({ limit: 100, cursor: at });
            walked.push(...ids(page));
            expect(page.nextCursor).not.toBe(at);
            at = page.nextCursor;
            calls++;
            expect(calls).toBeLessThan(40);
          } while (at);
          expect(walked).toEqual(expectedAll);
          expect((await walker.listItems()).map((item) => item.id)).toEqual(
            expectedAll,
          );
        }
        for (const row of ints) await setTime(row.id, row.receivedAt);
        // An over-long receipt value (ISO text plus 600 characters) could not
        // be carried by any cursor; such rows are excluded by the page query
        // too, so unkeyed, keyed and deprecated walks all reach the end.
        const long = ordered.slice(200, 350);
        for (const row of long)
          await setTime(row.id, `${row.receivedAt}${'x'.repeat(600)}`);
        const inLong = new Set(long.map((row) => row.id));
        const expectedShort = ordered
          .filter((row) => !inLong.has(row.id))
          .map((row) => row.id);
        for (const walker of [
          full,
          new IngestionService({
            ...options,
            db: counted,
            cursorKey: 'k'.repeat(32),
          }),
        ]) {
          const walked: string[] = [];
          let at: string | undefined;
          let calls = 0;
          do {
            const page = await walker.listItemsPage({ limit: 100, cursor: at });
            walked.push(...ids(page));
            at = page.nextCursor;
            calls++;
            expect(calls).toBeLessThan(40);
          } while (at);
          expect(walked).toEqual(expectedShort);
          expect((await walker.listItems()).map((item) => item.id)).toEqual(
            expectedShort,
          );
        }
        // A keyed one-row page that starts right before the long run: had the
        // long rows been fetched, it would have to seal a position on one.
        const keyedLong = new IngestionService({
          ...options,
          db: counted,
          cursorKey: 'k'.repeat(32),
        });
        const firstHundred = await keyedLong.listItemsPage({ limit: 100 });
        const secondHundred = await keyedLong.listItemsPage({
          limit: 100,
          cursor: firstHundred.nextCursor,
        });
        const pastLong = await keyedLong.listItemsPage({
          limit: 20,
          scanLimit: 1,
          cursor: secondHundred.nextCursor,
        });
        expect(ids(pastLong)).toEqual([ordered[350].id]);
        for (const row of long) await setTime(row.id, row.receivedAt);
        // A readable row whose id is not a UUID is skipped and counted like a
        // non-canonical receipt time: never listed, never named by an
        // unsealed cursor, and passed by a sealed one that stops on it.
        const anchorRow = visible[10];
        const legacy = ['legacy-a', 'legacy-b', 'legacy-c'];
        for (const [n, id] of legacy.entries()) {
          const at = new Date(
            Date.parse(anchorRow.receivedAt) - 100 * (n + 1),
          ).toISOString();
          const row: Record<string, unknown> = {
            ...template,
            id,
            slug: id,
            delivery_key: `legacy-${n}`,
            created_at: at,
            updated_at: at,
          };
          await db.query(
            `INSERT INTO intake_items (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            ...columns.map((column) => row[column]),
          );
        }
        const nextAfterAnchor =
          ordered[ordered.findIndex((row) => row.id === anchorRow.id) + 1];
        const keyedLegacy = new IngestionService({
          ...options,
          db: counted,
          cursorKey: 'k'.repeat(32),
          authorize: async (input) =>
            isSecret(input.capturedCeiling) ? false : options.authorize(input),
        });
        for (const walker of [paged, keyedLegacy]) {
          // Twelve rows: the eleven newest canonical rows, then legacy-a.
          const stop = await walker.listItemsPage({ limit: 20, scanLimit: 12 });
          expect(ids(stop)).toEqual(visible.slice(0, 11).map((row) => row.id));
          expect(stop.nextCursor).toBeTruthy();
          const resumed = await walker.listItemsPage({
            limit: 1,
            cursor: stop.nextCursor,
          });
          expect(ids(resumed)).toEqual([nextAfterAnchor.id]);
        }
        expect(
          (await full.listItems()).filter((item) => legacy.includes(item.id)),
        ).toEqual([]);
        await db.query(
          `DELETE FROM intake_items WHERE id IN (${legacy.map(() => '?').join(',')})`,
          ...legacy,
        );
        const insertRaw = async (id: string, createdAt: string, n: number) => {
          const row: Record<string, unknown> = {
            ...template,
            id,
            slug: `raw-${n}`,
            delivery_key: `raw-${n}`,
            created_at: createdAt,
            updated_at: createdAt,
          };
          await db.query(
            `INSERT INTO intake_items (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            ...columns.map((column) => row[column]),
          );
        };
        // Multi-byte and control characters within the 64-character limit:
        // SQLite counts code points, so the sealed plaintext must hold the
        // JSON-escaped UTF-8 position. A 64-emoji row sorts above every ISO
        // value, so a keyed one-row scan from the start stops on it; a
        // 64-control-character row sorts below every ISO value, so a keyed
        // one-row scan from the last canonical row stops on it.
        const emoji = '\u{1F600}'.repeat(64);
        const control = '\u0001'.repeat(64);
        // A shorter control-character row sorts below it, so the one-row scan
        // stops on the 64-character row with more rows after it and must seal
        // that position.
        const tail = '\u0002'.repeat(63);
        await insertRaw(emoji, emoji, 0);
        await insertRaw(control, control, 1);
        await insertRaw(tail, '\u0001'.repeat(63), 3);
        const keyedWide = new IngestionService({
          ...options,
          db: counted,
          cursorKey: 'k'.repeat(32),
        });
        const onEmoji = await keyedWide.listItemsPage({
          limit: 20,
          scanLimit: 1,
        });
        expect(onEmoji.items).toEqual([]);
        expect(onEmoji.nextCursor).toBeTruthy();
        expect(
          ids(
            await keyedWide.listItemsPage({
              limit: 1,
              cursor: onEmoji.nextCursor,
            }),
          ),
        ).toEqual([ordered[0].id]);
        let lastCursor: string | undefined;
        let walkAt: string | undefined;
        let walkCalls = 0;
        do {
          const page = await keyedWide.listItemsPage({
            limit: 100,
            cursor: walkAt,
          });
          lastCursor = page.items.at(-1)?.cursor ?? lastCursor;
          walkAt = page.nextCursor;
          walkCalls++;
          expect(walkCalls).toBeLessThan(40);
        } while (walkAt);
        const onControl = await keyedWide.listItemsPage({
          limit: 20,
          scanLimit: 1,
          cursor: lastCursor,
        });
        expect(onControl.items).toEqual([]);
        expect(onControl.nextCursor).toBeTruthy();
        expect(
          await keyedWide.listItemsPage({ cursor: onControl.nextCursor }),
        ).toMatchObject({ items: [] });
        await db.query(
          'DELETE FROM intake_items WHERE id IN (?, ?, ?)',
          emoji,
          control,
          tail,
        );
        // An embedded NUL: the row `K\0xxx` would come back truncated to `K`,
        // look canonical and sort above the legitimate row at exactly `K`; a
        // smaller id would then make paging skip that row. Excluded, the walk
        // lists the legitimate row and never the NUL one.
        const at = visible[12];
        const nulId = '00000000-0000-4000-8000-000000000000';
        await insertRaw(nulId, `${at.receivedAt}\u0000xxx`, 2);
        const stepped: string[] = [];
        let step: string | undefined;
        for (let n = 0; n < 15; n++) {
          const page = await full.listItemsPage({ limit: 1, cursor: step });
          stepped.push(...ids(page));
          step = page.nextCursor;
        }
        expect(stepped).toEqual(ordered.slice(0, 15).map((row) => row.id));
        expect(stepped).toContain(at.id);
        expect(stepped).not.toContain(nulId);
        await db.query('DELETE FROM intake_items WHERE id=?', nulId);
      }
      // A parseable but non-canonical receipt time between two canonical
      // neighbours (no milliseconds on SQLite, a sub-millisecond part on
      // PostgreSQL) is not listed either, and paging across it neither skips
      // nor repeats its neighbours.
      {
        const odd = visible[7];
        if (dialect === 'sqlite')
          await db.query(
            'UPDATE intake_items SET created_at=? WHERE id=?',
            odd.receivedAt.replace('.000Z', 'Z'),
            odd.id,
          );
        else
          await db.query(
            "UPDATE intake_items SET created_at = created_at + interval '500 microseconds' WHERE id=?",
            odd.id,
          );
        const rest = visible.filter((row) => row.id !== odd.id);
        const whole = await paged.listItemsPage();
        expect(ids(whole)).toEqual(rest.slice(0, 20).map((row) => row.id));
        expect(whole.scanned).toBe(21);
        const stepped: string[] = [];
        let step: string | undefined;
        for (let index = 0; index < 5; index++) {
          const page = await paged.listItemsPage({ limit: 3, cursor: step });
          stepped.push(...ids(page));
          step = page.nextCursor;
        }
        expect(stepped).toEqual(rest.slice(0, 15).map((row) => row.id));
        // A sealed cursor that stops on the non-canonical row has the same
        // length as one that stops on a canonical row, and two seals of the
        // same position differ (a fresh nonce per seal).
        const sealedOdd = new IngestionService({
          ...options,
          db: counted,
          cursorKey: 'k'.repeat(32),
          authorize: async (input) =>
            isSecret(input.capturedCeiling) ? false : options.authorize(input),
        });
        const oddStop = await sealedOdd.listItemsPage({
          limit: 20,
          scanLimit: 8,
        });
        expect(ids(oddStop)).toEqual(rest.slice(0, 7).map((row) => row.id));
        const canonicalStop = (await sealedOdd.listItemsPage({ limit: 1 }))
          .nextCursor;
        const again = (await sealedOdd.listItemsPage({ limit: 1 })).nextCursor;
        expect(String(oddStop.nextCursor).length).toBe(
          String(canonicalStop).length,
        );
        expect(again).not.toBe(canonicalStop);
        expect(
          ids(
            await sealedOdd.listItemsPage({
              limit: 1,
              cursor: oddStop.nextCursor,
            }),
          ),
        ).toEqual([rest[7].id]);
        await db.query(
          'UPDATE intake_items SET created_at=? WHERE id=?',
          odd.receivedAt,
          odd.id,
        );
        expect(ids(await paged.listItemsPage())).toEqual(ids(first));
      }
      // A call never hands back its own input cursor. A database that returns
      // the anchor row again (as SQLite did for integer receipt values before
      // they were excluded) makes a page fail closed, keyed or not, and the
      // deprecated walk stop with an error instead of looping.
      {
        let replay: unknown[] | undefined;
        let lastRows: unknown[] = [];
        const sticky = new Proxy(db, {
          get(target, property) {
            if (property === 'query')
              return async (...args: unknown[]) => {
                const result = await (
                  target.query as (
                    ...a: unknown[]
                  ) => Promise<{ rows: unknown[] }>
                )(...args);
                if (!String(args[0]).includes('FROM intake_items i'))
                  return result;
                lastRows = result.rows;
                return replay ? { ...result, rows: replay } : result;
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        for (const cursorKey of [undefined, 'k'.repeat(32)]) {
          replay = undefined;
          const stuck = new IngestionService({
            ...options,
            db: sticky,
            ...(cursorKey ? { cursorKey } : {}),
            authorize: async (input) =>
              isSecret(input.capturedCeiling)
                ? false
                : options.authorize(input),
          });
          const one = await stuck.listItemsPage({ limit: 1 });
          replay = Array.from({ length: 101 }, () => lastRows[0]);
          await expect(
            stuck.listItemsPage({
              limit: 20,
              scanLimit: 1,
              cursor: one.nextCursor,
            }),
          ).rejects.toThrow(/^Intake scan limit$/);
          await expect(stuck.listItems()).rejects.toThrow(
            'Intake list made no progress',
          );
        }
      }
      // A host authorization that throws rejects the page and the deprecated
      // walk with its error, as `load` does, instead of hiding rows; a
      // refusal still hides them quietly.
      {
        const flaky = new IngestionService({
          ...options,
          db: counted,
          authorize: async (input) => {
            if (isSecret(input.capturedCeiling))
              throw new Error('host authorization unavailable');
            return options.authorize(input);
          },
        });
        await expect(flaky.listItemsPage({ limit: 100 })).rejects.toThrow(
          'host authorization unavailable',
        );
        await expect(flaky.listItems()).rejects.toThrow(
          'host authorization unavailable',
        );
        expect(ids(await paged.listItemsPage({ limit: 100 }))).toEqual(
          visible.slice(0, 100).map((row) => row.id),
        );
      }
      // A caller's remaining budget bounds the scan below the ceiling.
      for (const input of [{ scanLimit: 0 }, { scanLimit: 1001 }])
        await expect(paged.listItemsPage(input)).rejects.toThrow(
          'Invalid item page',
        );
      const budgeted = await rare.listItemsPage({ limit: 20, scanLimit: 120 });
      expect(budgeted.scanned).toBe(120);
      expect(budgeted.nextCursor).toBeTruthy();
      // Cursors are the normalised ISO text the service stores; an offset
      // form that parses to the same instant is refused rather than compared
      // as text against stored rows.
      await expect(
        paged.listItemsPage({
          cursor: Buffer.from(
            JSON.stringify(['2026-10-01T05:00:00.000+05:00', visible[0].id]),
          ).toString('base64url'),
        }),
      ).rejects.toThrow('Invalid item page');

      // Cursor disclosure: no output may carry the id or receipt time of a
      // row the actor cannot read. A, B, C, D are the newest rows; B and C
      // are made unreadable.
      {
        // Past the two newest rows, which share a timestamp by design.
        const [A, B, C, D] = visible.slice(2, 6);
        const start = (await paged.listItemsPage({ limit: 2 })).nextCursor;
        const saved = new Map<string, unknown>();
        for (const row of [B, C]) {
          const stored = (
            await db.query('SELECT data FROM intake_items WHERE id=?', row.id)
          ).rows[0].data;
          saved.set(row.id, stored);
          const data =
            typeof stored === 'string'
              ? JSON.parse(stored)
              : structuredClone(stored);
          data.capturedCeiling = secret;
          await db.query(
            'UPDATE intake_items SET data=? WHERE id=?',
            JSON.stringify(data),
            row.id,
          );
        }
        const leaks = (cursor: string | undefined) => {
          if (!cursor) return false;
          const text = Buffer.from(cursor, 'base64url').toString('latin1');
          return [B, C].some(
            (row) =>
              text.includes(row.id) ||
              text.includes(row.receivedAt) ||
              cursor.includes(row.id),
          );
        };
        const opened = (cursor: string | undefined) =>
          JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        // Without a key: A is returned and the budget runs into B and C; the
        // cursor names A, the last returned row.
        const plain = await paged.listItemsPage({
          limit: 20,
          scanLimit: 3,
          cursor: start,
        });
        expect(ids(plain)).toEqual([A.id]);
        expect(opened(plain.nextCursor)).toEqual([A.receivedAt, A.id]);
        expect(leaks(plain.nextCursor)).toBe(false);
        // From A the next two rows are unreadable: no position may be
        // disclosed, so the call fails closed without naming either.
        const closed = await paged
          .listItemsPage({ limit: 20, scanLimit: 2, cursor: plain.nextCursor })
          .then(
            () => undefined,
            (error: Error) => error,
          );
        expect(closed?.message).toBe('Intake scan limit');
        expect(
          [B.id, C.id, B.receivedAt, C.receivedAt].some((value) =>
            String(closed?.message).includes(value),
          ),
        ).toBe(false);
        // With a key every cursor is sealed: the same call returns an opaque
        // position past B and C that decodes to nothing readable, and the
        // next call continues at D.
        const key = 'k'.repeat(32);
        const sealed = new IngestionService({
          ...options,
          db: counted,
          cursorKey: key,
          authorize: async (input) =>
            isSecret(input.capturedCeiling) ? false : options.authorize(input),
        });
        const atA = await sealed.listItemsPage({ limit: 3 });
        expect(ids(atA)).toEqual([visible[0].id, visible[1].id, A.id]);
        expect(() => opened(atA.nextCursor)).toThrow();
        const pastBC = await sealed.listItemsPage({
          limit: 20,
          scanLimit: 2,
          cursor: atA.nextCursor,
        });
        expect(pastBC.items).toEqual([]);
        expect(pastBC.scanned).toBe(2);
        expect(leaks(pastBC.nextCursor)).toBe(false);
        expect(() => opened(pastBC.nextCursor)).toThrow();
        expect(
          ids(
            await sealed.listItemsPage({ limit: 1, cursor: pastBC.nextCursor }),
          ),
        ).toEqual([D.id]);
        // Sealed and plain cursors are not interchangeable, tampering is
        // refused, and a sealed cursor is bound to the actor that got it.
        const bad = `${String(pastBC.nextCursor).slice(0, -2)}AA`;
        for (const [service, cursor] of [
          [sealed, plain.nextCursor],
          [paged, pastBC.nextCursor],
          [sealed, bad],
          [
            new IngestionService({
              ...options,
              cursorKey: key,
              scope: { ...options.scope, actorId: 'delegate' },
            }),
            pastBC.nextCursor,
          ],
        ] as const)
          await expect(
            service.listItemsPage({ cursor: String(cursor) }),
          ).rejects.toThrow('Invalid item page');
        expect(
          () => new IngestionService({ ...options, cursorKey: 'short' }),
        ).toThrow('at least 32 bytes');
        // An actor who can read nothing: a full scan of 1000 ceiling-denied
        // rows fails closed without a key; with a key it hands back a sealed
        // position and the walk ends after the remaining rows.
        const nobodyOptions = {
          ...options,
          db: counted,
          authorize: async () => false,
        };
        await expect(
          new IngestionService(nobodyOptions).listItemsPage(),
        ).rejects.toThrow(/^Intake scan limit$/);
        // The deprecated array API follows the internal scan position, so an
        // actor who can read nothing gets an empty list, as on main.
        expect(await new IngestionService(nobodyOptions).listItems()).toEqual(
          [],
        );
        const nobody = new IngestionService({
          ...nobodyOptions,
          cursorKey: key,
        });
        expect(await nobody.listItems()).toEqual([]);
        const firstScan = await nobody.listItemsPage();
        expect(firstScan.items).toEqual([]);
        expect(firstScan.scanned).toBe(1000);
        expect(firstScan.nextCursor).toBeTruthy();
        const lastScan = await nobody.listItemsPage({
          cursor: firstScan.nextCursor,
        });
        expect(lastScan.items).toEqual([]);
        expect(lastScan.scanned).toBe(500);
        expect(lastScan.nextCursor).toBeUndefined();
        for (const row of [B, C])
          await db.query(
            'UPDATE intake_items SET data=? WHERE id=?',
            typeof saved.get(row.id) === 'string'
              ? saved.get(row.id)
              : JSON.stringify(saved.get(row.id)),
            row.id,
          );
        expect(ids(await paged.listItemsPage())).toEqual(ids(first));
      }
      // A mostly-denied actor: only the rare ceiling is readable, so a page
      // needs many rows. Each call examines at most ITEM_SCAN_CEILING rows,
      // returns what it found with a cursor, and the walk still sees every
      // readable row exactly once, newest first.
      const rareCheck = async <T>(work: () => Promise<T>) => work();
      const hidden = ordered.filter((row) => row.expected === 'hidden');
      expect(hidden).toHaveLength(25);
      const found: string[] = [];
      let calls = 0;
      let short = false;
      cursor = undefined;
      do {
        queries = 0;
        const page = await rare.listItemsPage({ limit: 20, cursor });
        calls++;
        // Refills grow 20, 20, 40, 80, then 100-row batches up to the
        // 1000-row scan ceiling (thirteen page reads), each batch with at
        // most one handler-binding read when a passed row binds actions:
        // bounded by the ceiling, not by the item count.
        expect(queries).toBeLessThanOrEqual(26);
        if (page.nextCursor && page.items.length < 20) short = true;
        found.push(...ids(page));
        cursor = page.nextCursor;
      } while (cursor);
      expect(short).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(found).toEqual(hidden.map((row) => row.id));
      // 1500 seeded rows, every state filter walked to the end and both
      // cursor modes: well past the 30 s default on a loaded runner.
    }, 300_000);
    it('denies cross-tenant, cross-confidential and revoked access at reads and mutations', async () => {
      const id = await accepted();
      const evidence = (await service.getEvidence(id))[0];
      for (const scope of [
        { ...options.scope, tenantId: otherTenant },
        { ...options.scope, confidentialScopeId: 'other' },
        { ...options.scope, actorId: 'unrelated' },
      ]) {
        const outsider = new IngestionService({ ...options, scope });
        expect(await outsider.listItemsPage()).toMatchObject({ items: [] });
        expect(await outsider.listItems()).toEqual([]);
        await expect(outsider.getItem(id)).rejects.toThrow('unavailable');
        await expect(outsider.getEvidence(id)).rejects.toThrow('unavailable');
        await expect(outsider.readEvidence(id, evidence.id)).rejects.toThrow(
          'unavailable',
        );
        await expect(outsider.analyze(id, {}, 'forged')).rejects.toThrow(
          'unavailable',
        );
        await expect(outsider.expire(id)).rejects.toThrow('unavailable');
      }
      const delegate = new IngestionService({
        ...options,
        scope: { ...options.scope, actorId: 'delegate' },
      });
      expect((await delegate.getItem(id)).id).toBe(id);
      allowed = false;
      expect(await service.listItemsPage()).toMatchObject({ items: [] });
      expect(await service.listItems()).toEqual([]);
      await expect(service.getItem(id)).rejects.toThrow('unavailable');
      await expect(service.createAction(id, 'forged', {})).rejects.toThrow(
        'unavailable',
      );
      await expect(service.receive(receive('forged'))).rejects.toThrow(
        'unavailable',
      );
    });
    it('rejects malformed input, unsupported engines and bounded-output overflow', async () => {
      expect(await service.receive({ ...receive(), parts: [] })).toEqual({
        kind: 'rejected',
        category: 'limit',
      });
      expect(
        await service.receive({
          ...receive(),
          parts: [
            { partId: 'p', mediaType: 'text/plain', bytes: Buffer.alloc(5000) },
          ],
        }),
      ).toEqual({ kind: 'rejected', category: 'limit' });
      expect(
        () =>
          new IngestionService({
            ...options,
            db: {
              ...db,
              url: 'duckdb::memory:',
              type: 'duckdb',
            } as DatabaseInterface,
          }),
      ).toThrow('requires');
      const id = await accepted();
      const lease = await analysis(id);
      await expect(
        service.completeAnalysis(lease, {
          ...output,
          output: { text: 'x'.repeat(5000) },
        }),
      ).rejects.toThrow('budget');
      await expect(
        service.completeAnalysis(lease, {
          ...output,
          status: 'unknown' as 'completed',
        }),
      ).rejects.toThrow('Invalid');
      expect(await service.completeAnalysis(lease, output)).toBe(true);
    });
    it('rolls back all ledger updates through the owning transaction executor', async () => {
      const id = await accepted();
      await expect(
        db.transaction!(async (tx) => {
          await tx.query(
            "UPDATE intake_items SET trace_id='rollback' WHERE id=?",
            id,
          );
          await tx.query(
            "UPDATE intake_evidence SET state='broken' WHERE item_id=?",
            id,
          );
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await service.getItem(id)).traceId).not.toBe('rollback');
      expect(await service.getEvidence(id)).toHaveLength(1);
    });
    it('cancels workers without undoing receipt and rejects late completion', async () => {
      const id = await accepted();
      const lease = await analysis(id);
      await service.cancel(id);
      expect(await service.completeAnalysis(lease, output)).toBe(false);
      expect((await service.getItem(id)).receiptState).toBe('ready');
      expect((await service.getItem(id)).cancelled).toBe(true);
    });
    it('revokes before deletion, repairs purge failures and keeps replay/action tombstones', async () => {
      const input = receive();
      const receipt = await service.receive(input);
      if (!('itemId' in receipt)) throw new Error('receipt');
      const id = receipt.itemId;
      const action = await service.createAction(id, 'original', {});
      await db.query(
        "UPDATE intake_actions SET state='succeeded',result_digest='stable' WHERE id=?",
        action,
      );
      let failed = false;
      const deleting = new IngestionService({
        ...options,
        purgeDerived: async () => {
          if (!failed) {
            failed = true;
            throw new Error('index offline');
          }
          purges++;
        },
      });
      await expect(deleting.expire(id)).rejects.toThrow('index offline');
      await expect(service.getEvidence(id)).rejects.toThrow('unavailable');
      expect(await service.receive(input)).toEqual({
        kind: 'rejected',
        category: 'expired',
      });
      expect(await deleting.repairDeletions()).toBe(1);
      expect(purges).toBe(1);
      expect(
        (
          await db.query(
            'SELECT state,result_digest FROM intake_actions WHERE id=?',
            action,
          )
        ).rows[0],
      ).toMatchObject({ state: 'succeeded', result_digest: 'stable' });
      expect(
        Number((await db.query('SELECT COUNT(*) AS n FROM assets')).rows[0].n),
      ).toBe(0);
      expect(await deleting.repairDeletions()).toBe(0);
    });
    it('migrates manifest schemas and proves registry, database indexes and numeric parity', async () => {
      const schemas = Object.fromEntries(
        Object.keys(models).map((name) => {
          const schema = ObjectRegistry.getSchema(name)!;
          expect(schema).toBeTruthy();
          const runtime = new SchemaGenerator().generateSchemaFromRegistry(
            name,
            schema.tableName,
            ObjectRegistry.getFields(name),
            ObjectRegistry.getConfig(name),
          );
          expect(Object.keys(runtime.columns).sort()).toEqual(
            Object.keys(schema.columns).sort(),
          );
          expect(runtime.indexes.map((i) => i.name).sort()).toEqual(
            schema.indexes.map((i) => i.name).sort(),
          );
          return [schema.tableName, schema];
        }),
      );
      if (dialect === 'postgres')
        await db.query(`DROP TABLE ${Object.keys(schemas).join(',')} CASCADE`);
      else
        for (const table of Object.keys(schemas).reverse())
          await db.query(`DROP TABLE ${table}`);
      await expect(service.assertReady()).rejects.toThrow();
      const strategy = getDDLStrategy(dialect);
      const plan = planForeignKeyCreation(Object.values(schemas), dialect);
      const statements = plan.schemas
        .flatMap((schema) => [
          strategy.generateCreateTable(schema),
          ...strategy.generateIndexes(schema),
        ])
        .concat(plan.deferredStatements);
      const migration = createMigrationDefinition(
        '20261008_ingestion_foundation',
        statements,
        [],
        { packageName: '@happyvertical/smrt-ingestion', version: '0.55.4' },
      );
      const result = await new MigrationTracker({
        db,
        engineHint: dialect,
        useConcurrentIndexes: false,
      }).applyAll([migration], { postgresSafe: false });
      expect(result.every((r) => r.success)).toBe(true);
      await service.assertReady();
      const parity = await generateSchemaDiff(db, schemas, {
        engineHint: dialect,
      });
      expect(parity.added_tables).toHaveLength(0);
      expect(
        parity.changes.filter((c) => c.table.startsWith('intake_')),
      ).toEqual([]);
      await accepted('migrated');
    });
    it('bounds failed dispatch attempts and exposes needs-attention without losing receipt', async () => {
      const id = await accepted('queue-budget');
      await db.query('DELETE FROM _smrt_jobs');
      expect(await service.repairDispatches()).toBe(1);
      await db.query('DELETE FROM _smrt_jobs');
      expect(await service.repairDispatches()).toBe(0);
      expect(await service.getItem(id)).toMatchObject({
        receiptState: 'ready',
        processingState: 'needs_attention',
      });
    });
    it('purges feedback payloads and removes bytes written late by an expired preserver', async () => {
      const id = await accepted('privacy');
      const [original] = (
        await db.query(
          'SELECT source_uri FROM intake_evidence WHERE item_id=?',
          id,
        )
      ).rows;
      const filename = String(original.source_uri).replace('file://', '');
      await db.query(
        "INSERT INTO intake_feedback (id,slug,context,tenant_id,confidential_scope_id,item_id,request_key,supersedes_id,kind,data) VALUES (?,?,'',?,?,?, ?,NULL,'correctness',?)",
        randomUUID(),
        randomUUID(),
        tenant,
        'confidential',
        id,
        'human',
        JSON.stringify({ text: 'sensitive correction' }),
      );
      await service.expire(id);
      expect(
        (await db.query('SELECT data FROM intake_feedback WHERE item_id=?', id))
          .rows[0].data,
      ).toEqual(dialect === 'sqlite' ? '{}' : {});
      await writeFile(filename, 'late stale write');
      expect(await service.repairDeletions()).toBe(0);
      await expect(readFile(filename)).rejects.toThrow();
    });
    it('dispatches through the real durable TaskRunner into the scoped host stage', async () => {
      const id = await accepted('worker');
      const runner = createTaskRunner({
        pollInterval: 20,
        concurrency: 1,
        queues: ['ingestion'],
      });
      try {
        await runner.initialize(db);
        await runner.start();
        await vi.waitFor(
          async () =>
            expect((await service.getItem(id)).processingState).toBe(
              'completed',
            ),
          { timeout: 10000, interval: 30 },
        );
        const jobs = await SmrtJobCollection.create({ db });
        const events = await SmrtJobEventCollection.create({ db });
        await vi.waitFor(
          async () => {
            await withTenant({ tenantId: tenant }, async () => {
              const page = await events.listTerminalOutcomes({
                tenantId: tenant,
                queues: ['ingestion'],
              });
              expect(page.outcomes).toHaveLength(1);
              expect(page.outcomes[0]).toMatchObject({
                tenantId: tenant,
                status: 'completed',
                objectType: options.jobTarget.objectType,
                method: options.jobTarget.method,
                attempts: 1,
              });
              expect(
                (await jobs.get({ id: page.outcomes[0].jobId }))?.status,
              ).toBe('completed');
            });
          },
          { timeout: 10000, interval: 30 },
        );
        expect(
          Number(
            (
              await db.query(
                "SELECT COUNT(*) AS n FROM intake_analysis_attempts WHERE state='completed'",
              )
            ).rows[0].n,
          ),
        ).toBe(1);
      } finally {
        await runner.stop();
      }
    });
    it('declares tenant-led identities and disabled generated transports for every model', () => {
      for (const name of Object.keys(models)) {
        const registered = ObjectRegistry.getClass(name);
        expect(registered).toBeTruthy();
        expect(ObjectRegistry.getConflictColumns(name)[0]).toBe('tenant_id');
      }
    });
  });
}

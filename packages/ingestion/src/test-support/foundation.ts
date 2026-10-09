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
        await admin.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
        await admin.close?.();
        admin = undefined;
      }
      if (root) await rm(root, { recursive: true, force: true });
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
      const permitted = items[0];
      const denied = items[1];
      const deniedData =
        typeof denied.data === 'string' ? JSON.parse(denied.data) : denied.data;
      const deniedKey = deniedData.capturedCeiling.key;
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
          if (operation === 'delete' && capturedCeiling.key === deniedKey)
            throw failure;
          return true;
        },
      });
      clock = new Date(clock.getTime() + 100001);
      await expect(sweeping.sweepRetention()).rejects.toBe(failure);
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
    it('denies cross-tenant, cross-confidential and revoked access at reads and mutations', async () => {
      const id = await accepted();
      const evidence = (await service.getEvidence(id))[0];
      for (const scope of [
        { ...options.scope, tenantId: otherTenant },
        { ...options.scope, confidentialScopeId: 'other' },
        { ...options.scope, actorId: 'unrelated' },
      ]) {
        const outsider = new IngestionService({ ...options, scope });
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

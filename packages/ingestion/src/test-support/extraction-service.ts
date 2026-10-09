import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAnalysis } from '../extraction.js';
import { extractWithProviders } from '../extraction-providers.js';
import * as models from '../models.js';
import {
  type AnalysisLease,
  type IngestionOptions,
  IngestionService,
} from '../server.js';
import { extractionLimits } from './extraction-fixtures.js';

export function extractionServiceSuite(dialect: 'sqlite' | 'postgres') {
  describe(`extraction authority and publication on ${dialect}`, () => {
    let db: DatabaseInterface,
      admin: DatabaseInterface | undefined,
      root: string,
      databaseName: string;
    let service: IngestionService,
      options: IngestionOptions,
      lease: AnalysisLease,
      allowed: boolean,
      clock: Date;
    const extraction = {
      configurationRevision: 'v1',
      limits: extractionLimits,
    };
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'ext-'));
      allowed = true;
      clock = new Date();
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
      ];
      if (dialect === 'postgres') {
        if (!process.env.DATABASE_URL)
          throw new Error('PostgreSQL unavailable');
        admin = await getTestDatabase({
          type: 'postgres',
          url: process.env.DATABASE_URL,
          classes: [],
          includeSystemTables: false,
        });
        databaseName = `ext_${randomUUID().replaceAll('-', '')}`;
        await admin.query(`CREATE DATABASE ${databaseName}`);
        const url = new URL(process.env.DATABASE_URL);
        url.pathname = `/${databaseName}`;
        db = await getTestDatabase({
          type: 'postgres',
          url: url.toString(),
          classes,
        });
      } else
        db = await getTestDatabase({
          type: 'sqlite',
          url: `file:${join(root, 'test.sqlite')}`,
          classes,
        });
      options = {
        db,
        assets: await createAssetRuntime({ db, storage: join(root, 'assets') }),
        scope: {
          tenantId: '11111111-1111-4111-8111-111111111111',
          actorId: 'owner',
          confidentialScopeId: 'private',
        },
        authorize: async ({ scope }) => allowed && scope.actorId === 'owner',
        jobTarget: { objectType: 'IntakeItem', method: 'process' },
        purgeDerived: async () => {},
        now: () => clock,
      };
      service = new IngestionService(options);
      const receipt = await service.receive({
        sourceId: 'email',
        sourceVersion: '1',
        deliveryKey: 'mail1',
        deliveredAt: clock,
        parts: [
          {
            partId: 'body',
            bytes: Buffer.from('please retain'),
            mediaType: 'text/plain',
          },
          {
            partId: 'attachment',
            parentPartId: 'body',
            bytes: Buffer.from('attached text'),
            mediaType: 'text/plain',
          },
        ],
        capturedCeiling: { extraction: true },
        retention: {
          version: '1',
          expiresAt: new Date(+clock + 600000),
          replayUntil: new Date(+clock + 1200000),
          acceptAfter: new Date(+clock - 1000),
        },
        limits: {
          maxBytes: 4096,
          maxParts: 2,
          maxAttempts: 3,
          leaseMs: 30000,
          maxOutputBytes: 65536,
        },
      });
      if (!('itemId' in receipt)) throw new Error(`Receipt ${receipt.kind}`);
      const analysis = await service.analyze(
        receipt.itemId,
        { extraction },
        'analysis1',
      );
      const claimed = await service.claimAnalysis(
        receipt.itemId,
        analysis.revision,
        'extractor',
      );
      if (!claimed) throw new Error('No lease');
      lease = claimed;
    });
    afterEach(async () => {
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
    it('persists linked normalized evidence once and originals remain readable', async () => {
      expect(
        await extractAnalysis(
          service,
          lease,
          { extract: (request) => extractWithProviders(request, {}) },
          extraction,
        ),
      ).toBe(true);
      const rows = await db.query(
        'SELECT data FROM intake_analysis_attempts WHERE id=?',
        lease.attemptId,
      );
      expect(JSON.stringify(rows)).toContain('attached text');
      const evidence = await service.getEvidence(lease.itemId);
      expect(evidence).toHaveLength(2);
      expect(
        evidence.find((e) => e.partId === 'attachment')?.parentEvidenceId,
      ).toBe(evidence.find((e) => e.partId === 'body')?.id);
      expect(
        Buffer.from(await service.readEvidence(lease.itemId, evidence[0].id))
          .length,
      ).toBeGreaterThan(0);
      await expect(
        extractAnalysis(
          service,
          lease,
          { extract: (request) => extractWithProviders(request, {}) },
          extraction,
        ),
      ).rejects.toThrow('lease');
    });
    it('denies actor, tenant, scope, expired/wrong/stale lease and config before provider', async () => {
      const extract = vi.fn(
        (request: Parameters<typeof extractWithProviders>[0]) =>
          extractWithProviders(request, {}),
      );
      for (const scope of [
        { ...options.scope, actorId: 'intruder' },
        { ...options.scope, tenantId: randomUUID() },
        { ...options.scope, confidentialScopeId: 'other' },
      ]) {
        await expect(
          extractAnalysis(
            new IngestionService({ ...options, scope }),
            lease,
            { extract },
            extraction,
          ),
        ).rejects.toThrow();
      }
      for (const bad of [
        { ...lease, token: 'wrong' },
        { ...lease, fence: lease.fence + 1 },
        { ...lease, revision: lease.revision + 1 },
      ])
        await expect(
          extractAnalysis(service, bad, { extract }, extraction),
        ).rejects.toThrow();
      await expect(
        extractAnalysis(
          service,
          lease,
          { extract },
          { ...extraction, configurationRevision: 'v2' },
        ),
      ).rejects.toThrow('configuration');
      clock = new Date(+clock + 31000);
      await expect(
        extractAnalysis(service, lease, { extract }, extraction),
      ).rejects.toThrow('lease');
      expect(extract).not.toHaveBeenCalled();
    });
    it('rechecks live grants after external call and cannot publish revoked content', async () => {
      const extract = vi.fn(
        async (request: Parameters<typeof extractWithProviders>[0]) => {
          const result = await extractWithProviders(request, {});
          allowed = false;
          return result;
        },
      );
      await expect(
        extractAnalysis(service, lease, { extract }, extraction),
      ).rejects.toThrow();
      expect(extract).toHaveBeenCalledTimes(1);
      const rows = await db.query(
        'SELECT output_digest FROM intake_analysis_attempts WHERE id=?',
        lease.attemptId,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].output_digest).toBe('');
      allowed = true;
      const snapshot = await service.getAnalysisInput(lease);
      expect(snapshot.evidence).toHaveLength(2);
    });
    it('rejects unknown adapter status and forged evidence provenance before publication', async () => {
      for (const corruption of ['status', 'evidence'] as const) {
        await expect(
          extractAnalysis(
            service,
            lease,
            {
              extract: async (request) => {
                const result = await extractWithProviders(request, {});
                if (corruption === 'status') result.status = 'unknown' as never;
                else result.evidence.contentHash = 'forged';
                return result;
              },
            },
            extraction,
          ),
        ).rejects.toThrow('Invalid extraction output');
      }
      const rows = await db.query(
        'SELECT output_digest FROM intake_analysis_attempts WHERE id=?',
        lease.attemptId,
      );
      expect(rows.rows[0].output_digest).toBe('');
    });
    it('creates a new immutable config revision and supersedes old lease', async () => {
      const next = await service.analyze(
        lease.itemId,
        { extraction: { ...extraction, configurationRevision: 'v2' } },
        'analysis2',
      );
      expect(next.revision).toBe(lease.revision + 1);
      await expect(service.getAnalysisInput(lease)).rejects.toThrow();
      const second = await service.claimAnalysis(
        lease.itemId,
        next.revision,
        'extractor',
      );
      expect(second).not.toBeNull();
      if (!second) throw new Error('No second lease');
      expect(
        (await service.getAnalysisInput(second)).configuration,
      ).toMatchObject({ extraction: { configurationRevision: 'v2' } });
    });
  });
}

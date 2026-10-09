import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { extractionLimits, scannedPDF } from './extraction-fixtures.js';

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
    let receive: (maxOutputBytes?: number, pdf?: boolean) => Promise<void>;
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
      receive = async (maxOutputBytes = 65536, pdf = false) => {
        const receipt = await service.receive({
          sourceId: 'email',
          sourceVersion: '1',
          deliveryKey: randomUUID(),
          deliveredAt: clock,
          parts: pdf
            ? [
                {
                  partId: 'scan',
                  bytes: scannedPDF(true, true),
                  mediaType: 'application/pdf',
                },
              ]
            : [
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
            maxOutputBytes,
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
      };
      await receive();
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
    it.each([
      'revocation',
      'expiry',
      'supersession',
    ] as const)('stops real child OCR requests after first page %s', async (cause) => {
      await receive(65536, true);
      let requests = 0;
      const server = createServer(async (request, response) => {
        request.resume();
        requests++;
        if (requests === 1) {
          if (cause === 'revocation') allowed = false;
          else if (cause === 'expiry') clock = new Date(+clock + 31000);
          else
            await service.analyze(
              lease.itemId,
              { extraction, next: true },
              'superseding',
            );
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ choices: [{ message: { content: 'First page' } }] }),
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No address');
      try {
        const { createSDKExtractionAdapter } = await import(
          /* @vite-ignore */ pathToFileURL(resolve('dist/server.js')).href
        );
        const adapter = createSDKExtractionAdapter({
          nativeMemoryIsolation: 'host-enforced',
          pdf: {
            provider: 'unpdf',
            identity: { provider: 'unpdf', model: 'none', version: 'unknown' },
          },
          ocr: {
            identity: {
              provider: 'unlimited-ocr',
              model: 'Unlimited-OCR',
              version: 'unknown',
            },
            options: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              transport: 'direct',
              stream: false,
            },
          },
        });
        await expect(
          extractAnalysis(service, lease, adapter, extraction),
        ).rejects.toThrow();
        expect(requests).toBe(1);
        const rows = await db.query(
          'SELECT output_digest FROM intake_analysis_attempts WHERE id=?',
          lease.attemptId,
        );
        expect(rows.rows[0].output_digest).toBe('');
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
    it('budgets multipart output including metadata and retains fitting earlier work', async () => {
      await receive(2300);
      let calls = 0;
      expect(
        await extractAnalysis(
          service,
          lease,
          {
            extract: async (request) => {
              calls++;
              const result = await extractWithProviders(request, {});
              result.segments[0].text = 'x'.repeat(450);
              return result;
            },
          },
          extraction,
        ),
      ).toBe(true);
      expect(calls).toBe(2);
      const rows = await db.query(
        'SELECT state,safe_error,data FROM intake_analysis_attempts WHERE id=?',
        lease.attemptId,
      );
      expect(rows.rows[0]).toMatchObject({
        state: 'partial',
        safe_error: 'limit',
      });
      const data =
        typeof rows.rows[0].data === 'string'
          ? JSON.parse(rows.rows[0].data)
          : rows.rows[0].data;
      expect(data.output.results[0].segments[0].text).toBe('x'.repeat(450));
      const { status, provider, model, version, output, usage, error } = data;
      expect(
        Buffer.byteLength(
          JSON.stringify({
            status,
            provider,
            model,
            version,
            output,
            usage,
            error,
          }),
        ),
      ).toBeLessThanOrEqual(2300);
    });
    it('counts provider metadata even when segment text fits', async () => {
      await receive(1600);
      expect(
        await extractAnalysis(
          service,
          lease,
          {
            extract: async (request) => {
              const result = await extractWithProviders(request, {});
              result.capabilities[0].version = 'metadata'.repeat(500);
              return result;
            },
          },
          extraction,
        ),
      ).toBe(true);
      const rows = await db.query(
        'SELECT state,safe_error,data FROM intake_analysis_attempts WHERE id=?',
        lease.attemptId,
      );
      expect(rows.rows[0]).toMatchObject({
        state: 'needs_attention',
        safe_error: 'limit',
      });
      expect(JSON.stringify(rows.rows[0].data)).not.toContain('metadata');
    });
    it.each([
      1, 128, 192,
    ])('terminates safely without providers for ceiling %s', async (ceiling) => {
      await receive(ceiling);
      const extract = vi.fn(
        (request: Parameters<typeof extractWithProviders>[0]) =>
          extractWithProviders(request, {}),
      );
      expect(
        await extractAnalysis(service, lease, { extract }, extraction),
      ).toBe(true);
      expect(extract).not.toHaveBeenCalled();
      const rows = await db.query(
        'SELECT state,safe_error,output_digest,data FROM intake_analysis_attempts WHERE id=?',
        lease.attemptId,
      );
      expect(rows.rows[0]).toMatchObject({
        state: 'needs_attention',
        safe_error: 'limit',
      });
      if (ceiling < 160) {
        expect(rows.rows[0].output_digest).toBe('');
        const data =
          typeof rows.rows[0].data === 'string'
            ? JSON.parse(rows.rows[0].data)
            : rows.rows[0].data;
        expect(data.output).toBeUndefined();
      }
      for (const [table, column, id] of [
        ['intake_items', 'processing_state', lease.itemId],
        ['intake_analyses', 'state', lease.analysisId],
      ]) {
        const projection = await db.query(
          `SELECT ${column} FROM ${table} WHERE id=?`,
          id,
        );
        expect(projection.rows[0][column]).toBe('needs_attention');
      }
      const dispatch = await db.query(
        'SELECT state FROM intake_dispatches WHERE item_id=? AND revision=?',
        lease.itemId,
        lease.revision,
      );
      expect(dispatch.rows.every((row) => row.state === 'completed')).toBe(
        true,
      );
      expect(await service.failAnalysis(lease, 'limit')).toBe(false);
    });
    it('fences failure accounting against foreign, revoked, expired and superseded leases', async () => {
      for (const scope of [
        { ...options.scope, actorId: 'intruder' },
        { ...options.scope, tenantId: randomUUID() },
        { ...options.scope, confidentialScopeId: 'other' },
      ])
        await expect(
          new IngestionService({ ...options, scope }).failAnalysis(
            lease,
            'limit',
          ),
        ).rejects.toThrow();
      for (const bad of [
        { ...lease, token: 'wrong' },
        { ...lease, fence: lease.fence + 1 },
        { ...lease, revision: lease.revision + 1 },
      ])
        expect(await service.failAnalysis(bad, 'limit')).toBe(false);
      allowed = false;
      await expect(service.failAnalysis(lease, 'limit')).rejects.toThrow();
      allowed = true;
      clock = new Date(+clock + 31000);
      expect(await service.failAnalysis(lease, 'limit')).toBe(false);
      clock = new Date(+clock - 31000);
      await service.analyze(lease.itemId, { extraction, next: true }, 'next');
      expect(await service.failAnalysis(lease, 'limit')).toBe(false);
      const rows = await db.query(
        'SELECT safe_error,output_digest FROM intake_analysis_attempts WHERE id=?',
        lease.attemptId,
      );
      expect(rows.rows[0].output_digest).toBe('');
      expect(rows.rows[0].safe_error).not.toBe('limit');
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

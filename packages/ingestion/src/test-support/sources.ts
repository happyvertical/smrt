import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as models from '../models.js';
import { type IngestionOptions, IngestionService } from '../server.js';
import {
  type AuthenticatedSource,
  createSourceDeliveryHandler,
  createVendorWebhookHandler,
  type EmailIntakeSnapshot,
  EmailSourceAdapter,
  WatchFolderSourceAdapter,
} from '../sources/index.js';
import { dropExecutionDatabase } from './postgres-cleanup.js';

const tenant = '11111111-1111-4111-8111-111111111111';
export function sourcesSuite(
  dialect: 'sqlite' | 'postgres',
  workerType: string,
): void {
  describe(`source intake on ${dialect}`, () => {
    let db: DatabaseInterface;
    let admin: DatabaseInterface | undefined;
    let databaseName: string;
    let databaseUrl: string;
    let root: string;
    let service: IngestionService;
    let binding: AuthenticatedSource;
    let options: IngestionOptions;
    let allowed: boolean;
    let clock: number;
    const capturedAt = '2026-10-08T12:00:00.000Z';
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'src-'));
      clock = Date.parse(capturedAt);
      allowed = true;
      if (dialect === 'postgres') {
        const base = process.env.DATABASE_URL;
        if (!base) throw new Error('PostgreSQL required');
        admin = await getTestDatabase({
          type: 'postgres',
          url: base,
          classes: [],
          includeSystemTables: false,
        });
        databaseName = `sources_${randomUUID().replaceAll('-', '')}`;
        await admin.query(`CREATE DATABASE ${databaseName}`);
        const url = new URL(base);
        url.pathname = `/${databaseName}`;
        databaseUrl = url.toString();
      } else databaseUrl = `file:${join(root, 'db.sqlite')}`;
      db = await getTestDatabase({
        type: dialect,
        url: databaseUrl,
        classes: [
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
          workerType,
        ],
      });
      options = {
        db,
        assets: await createAssetRuntime({ db, storage: join(root, 'assets') }),
        scope: {
          tenantId: tenant,
          actorId: 'owner',
          confidentialScopeId: 'scope',
        },
        authorize: async ({ scope }) => allowed && scope.actorId === 'owner',
        jobTarget: { objectType: workerType, method: 'process' },
        purgeDerived: async () => {},
        now: () => new Date(clock),
      };
      service = new IngestionService(options);
      binding = {
        enabled: true,
        service,
        sourceId: 'configured-source',
        sourceVersion: '1',
        capturedCeiling: { allowed: ['draft'] },
        retention: {
          version: '1',
          expiresAt: new Date(clock + 86400000 * 30),
          replayUntil: new Date(clock + 86400000 * 60),
          acceptAfter: new Date(clock - 86400000 * 30),
        },
        limits: {
          maxBytes: 4096,
          maxParts: 10,
          maxAttempts: 2,
          leaseMs: 20,
          maxOutputBytes: 4096,
        },
        allowedMediaTypes: [
          'application/json',
          'text/plain',
          'application/pdf',
          'image/tiff',
          'image/png',
          'audio/wav',
        ],
        maxRequestBytes: 8192,
      };
    });
    afterEach(async () => {
      await db?.close?.();
      if (admin) {
        await dropExecutionDatabase(admin, databaseName);
        await admin.close?.();
        admin = undefined;
      }
      await rm(root, { recursive: true, force: true });
    });
    function handler(source: AuthenticatedSource | null = binding) {
      return createSourceDeliveryHandler({ authenticate: async () => source });
    }
    function json(body: unknown, key = 'delivery') {
      return new Request('https://host/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
    }
    async function count() {
      return Number(
        (await db.query('SELECT COUNT(*) AS n FROM intake_items')).rows[0].n,
      );
    }
    async function upload(
      type = 'application/pdf',
      bytes = Buffer.from('%PDF-original'),
      fields: Record<string, string> = {},
    ) {
      const form = new FormData();
      for (const [key, value] of Object.entries({
        captureId: 'capture',
        capturedAt,
        captureSource: 'document',
        ...fields,
      }))
        form.set(key, value);
      form.set('file', new Blob([bytes], { type }), 'original');
      const request = new Request('https://host/intake', {
        method: 'POST',
        headers: { 'idempotency-key': 'capture' },
        body: form,
      });
      // Serialize real multipart framing before delivery, as a network peer does.
      return new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: await request.arrayBuffer(),
      });
    }
    it('authenticates and denies forged authority, revoked actors and isolated source scopes', async () => {
      expect(
        (await handler(null)(json({ text: 'x', capturedAt }))).status,
      ).toBe(401);
      for (const field of [
        'tenantId',
        'actorId',
        'sourceId',
        'confidentialScopeId',
      ])
        expect(
          (await handler()(json({ text: 'x', capturedAt, [field]: 'forged' })))
            .status,
        ).toBe(400);
      expect(await count()).toBe(0);
      const accepted = await (
        await handler()(json({ text: 'x', capturedAt }))
      ).json();
      expect(accepted.kind).toBe('accepted');
      expect(
        await (await handler()(json({ text: 'x', capturedAt }))).json(),
      ).toMatchObject({ kind: 'duplicate', itemId: accepted.itemId });
      for (const change of [
        { actorId: 'other' },
        { confidentialScopeId: 'other' },
      ]) {
        const other = new IngestionService({
          ...options,
          scope: { ...options.scope, ...change },
        });
        const result = await (
          await handler({ ...binding, service: other })(
            json({ text: 'x', capturedAt }),
          )
        ).json();
        expect(['retry', 'rejected']).toContain(result.kind);
      }
      const otherTenant = new IngestionService({
        ...options,
        scope: {
          ...options.scope,
          tenantId: '22222222-2222-4222-8222-222222222222',
        },
      });
      await expect(otherTenant.getItem(accepted.itemId)).rejects.toThrow();
      expect(
        (
          await (
            await handler({ ...binding, service: otherTenant })(
              json({ text: 'x', capturedAt }),
            )
          ).json()
        ).kind,
      ).toBe('accepted');
      allowed = false;
      expect(
        (await handler()(json({ text: 'x', capturedAt }, 'revoked'))).status,
      ).toBe(503);
      expect(await count()).toBe(2);
    });
    it('retains original upload bytes and capture metadata; replay conflicts and bounds fail explicitly', async () => {
      const receipt = await (await handler()(await upload())).json();
      expect(receipt.kind).toBe('accepted');
      const evidence = await service.getEvidence(receipt.itemId);
      const original = evidence.find((e) => e.partId === 'file')!;
      const capture = evidence.find((e) => e.partId === 'capture')!;
      expect(original.parentEvidenceId).toBe(capture.id);
      expect(
        Buffer.from(
          await service.readEvidence(receipt.itemId, original.id),
        ).toString(),
      ).toBe('%PDF-original');
      expect(
        JSON.parse(
          Buffer.from(
            await service.readEvidence(receipt.itemId, capture.id),
          ).toString(),
        ),
      ).toMatchObject({ captureId: 'capture', capturedAt });
      expect(await (await handler()(await upload())).json()).toMatchObject({
        kind: 'duplicate',
        itemId: receipt.itemId,
      });
      const reordered = new FormData();
      for (const [name, value] of [
        ...(await (await upload()).formData()).entries(),
      ].reverse())
        reordered.append(name, value);
      const reorderedRequest = new Request('https://host/intake', {
        method: 'POST',
        headers: { 'idempotency-key': 'capture' },
        body: reordered,
      });
      expect(
        await (
          await handler()(
            new Request(reorderedRequest.url, {
              method: 'POST',
              headers: reorderedRequest.headers,
              body: await reorderedRequest.arrayBuffer(),
            }),
          )
        ).json(),
      ).toMatchObject({ kind: 'duplicate', itemId: receipt.itemId });
      expect(
        await (
          await handler()(
            await upload('application/pdf', Buffer.from('%PDF-changed')),
          )
        ).json(),
      ).toMatchObject({ kind: 'rejected', category: 'conflict' });
      expect(
        (await handler()(await upload('application/pdf', Buffer.from('fake'))))
          .status,
      ).toBe(400);
      expect((await handler()(await upload('video/mp4'))).status).toBe(400);
      expect(
        (await handler()(await upload('application/pdf', Buffer.alloc(9000))))
          .status,
      ).toBe(413);
      expect(
        (
          await handler()(
            await upload('application/pdf', Buffer.from('%PDF-original'), {
              tenantId: 'forged',
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await handler()(
            await upload('application/pdf', Buffer.from('%PDF-original'), {
              sha256: '0'.repeat(64),
            }),
          )
        ).status,
      ).toBe(400);
      expect(await count()).toBe(1);
    });
    it('accepts camera/audio signatures, structured payloads and authorized owner copies', async () => {
      for (const [type, bytes] of [
        ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
        ['audio/wav', Buffer.from('RIFF0000WAVE')],
      ] as const) {
        expect(
          (
            await (
              await handler({ ...binding, sourceId: type })(
                await upload(type, bytes, {
                  captureSource:
                    type === 'image/png' ? 'native_picker' : 'audio',
                }),
              )
            ).json()
          ).kind,
        ).toBe('accepted');
      }
      expect(
        (
          await (
            await handler()(
              json(
                {
                  capturedAt,
                  structured: {
                    kind: 'unknown-provider-value',
                    optional: null,
                  },
                },
                'structured',
              ),
            )
          ).json()
        ).kind,
      ).toBe('accepted');
      const reference = { owner: 'asset', id: 'owned', version: '1' };
      binding.snapshotReference = async (ref) => {
        expect(ref).toEqual(reference);
        return [
          {
            partId: 'owner',
            mediaType: 'application/pdf',
            bytes: Buffer.from('%PDF-owned'),
          },
        ];
      };
      expect(
        (await (await handler()(json({ capturedAt, reference }, 'ref'))).json())
          .kind,
      ).toBe('accepted');
      binding.snapshotReference = async () => [];
      expect(
        await (
          await handler()(json({ capturedAt, reference }, 'absent'))
        ).json(),
      ).toMatchObject({ kind: 'rejected', category: 'unavailable_bytes' });
      binding.snapshotReference = async () => {
        throw new Error('private-secret-provider-error');
      };
      expect(
        await (
          await handler()(json({ capturedAt, reference }, 'denied'))
        ).text(),
      ).not.toContain('private-secret');
      expect(await count()).toBe(4);
    });
    it('bounds chunked bodies and handles malformed JSON / upstream stream failure', async () => {
      const chunks = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(Buffer.alloc(5000));
          c.enqueue(Buffer.alloc(5000));
          c.close();
        },
      });
      const request = new Request('https://host/intake', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'chunks',
        },
        body: chunks,
        duplex: 'half',
      } as RequestInit);
      expect((await handler()(request)).status).toBe(413);
      expect(
        (
          await handler()(
            new Request('https://host/intake', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'idempotency-key': 'bad',
              },
              body: '{',
            }),
          )
        ).status,
      ).toBe(400);
      expect((await handler()(json({ text: 'x' }))).status).toBe(400);
      expect(await count()).toBe(0);
    });
    it('preserves email thread and attachment parents exactly once and advances checkpoints only on complete receipt', async () => {
      const snapshot: EmailIntakeSnapshot = {
        accountId: 'account',
        messageId: 'rfc',
        threadId: 'thread',
        inReplyTo: 'parent',
        subject: 'hello',
        text: 'body',
        html: '',
        date: capturedAt,
        attachments: [
          {
            partId: '0',
            filename: 'a.pdf',
            mediaType: 'application/pdf',
            bytes: Buffer.from('%PDF-a'),
          },
          {
            partId: '1',
            filename: 'b.tif',
            mediaType: 'image/tiff',
            bytes: Buffer.from([73, 73, 42, 0]),
          },
        ],
      };
      Object.assign(snapshot, { providerSecret: 'must-not-be-retained' });
      const checkpoints: string[] = [];
      let unavailable: boolean | 'limit' = false;
      const adapter = new EmailSourceAdapter({
        binding,
        accountId: 'account',
        readMessage: async () => {
          if (unavailable === 'limit')
            throw Object.assign(new Error('safe byte limit'), {
              name: 'EmailIntakeSnapshotError',
              category: 'limit',
            });
          if (unavailable) throw new Error('provider-secret');
          return snapshot;
        },
        acknowledge: async (value) => {
          checkpoints.push(value);
        },
      });
      const delivery = {
        locator: 'INBOX:uidvalidity:42',
        revision: '1',
        checkpoint: '42',
      };
      const first = await adapter.receive(delivery);
      expect(first.kind).toBe('accepted');
      if (!('itemId' in first)) throw new Error('receipt missing');
      const evidence = await service.getEvidence(first.itemId);
      expect(evidence).toHaveLength(3);
      const parent = evidence.find((e) => e.partId === 'message')!;
      expect(
        evidence.filter((e) => e.parentEvidenceId === parent.id),
      ).toHaveLength(2);
      expect(
        JSON.parse(
          Buffer.from(
            await service.readEvidence(first.itemId, parent.id),
          ).toString(),
        ),
      ).toMatchObject({ threadId: 'thread', inReplyTo: 'parent' });
      expect(
        Buffer.from(
          await service.readEvidence(first.itemId, parent.id),
        ).toString(),
      ).not.toContain('must-not-be-retained');
      expect(await adapter.receive(delivery)).toMatchObject({
        kind: 'duplicate',
        itemId: first.itemId,
      });
      snapshot.text = 'revised';
      expect(await adapter.receive(delivery)).toMatchObject({
        kind: 'rejected',
        category: 'conflict',
      });
      expect((await adapter.receive({ ...delivery, revision: '2' })).kind).toBe(
        'accepted',
      );
      unavailable = true;
      expect(
        await adapter.receiveBatch([
          { ...delivery, locator: '43', checkpoint: '43' },
          { ...delivery, locator: '44', checkpoint: '44' },
        ]),
      ).toEqual([{ kind: 'retry', category: 'unavailable' }]);
      expect(checkpoints).toEqual(['42', '42', '42']);
      unavailable = 'limit';
      expect(
        await adapter.receive({ ...delivery, locator: '46' }),
      ).toMatchObject({ kind: 'rejected', category: 'limit' });
      unavailable = false;
      snapshot.accountId = 'forged';
      expect(
        await adapter.receive({ ...delivery, locator: '45' }),
      ).toMatchObject({ category: 'authentication' });
      expect(await count()).toBe(2);
    });
    it('retries failed email checkpoint without duplicating bytes and rejects missing/oversized attachments', async () => {
      const snapshot: EmailIntakeSnapshot = {
        accountId: 'account',
        messageId: 'id',
        threadId: '',
        inReplyTo: '',
        subject: '',
        text: 'body',
        html: '',
        date: capturedAt,
        attachments: [],
      };
      let failAck = true;
      let reads = 0;
      const adapter = new EmailSourceAdapter({
        binding,
        accountId: 'account',
        readMessage: async () => {
          reads++;
          return snapshot;
        },
        acknowledge: async () => {
          if (failAck) throw new Error('checkpoint offline secret');
        },
      });
      const delivery = { locator: '42', revision: '1', checkpoint: '42' };
      expect(await adapter.receive(delivery)).toEqual({
        kind: 'retry',
        category: 'unavailable',
      });
      expect(await count()).toBe(1);
      failAck = false;
      expect((await adapter.receive(delivery)).kind).toBe('duplicate');
      snapshot.attachments = [
        {
          partId: '0',
          filename: '',
          mediaType: 'application/pdf',
          bytes: undefined as unknown as Uint8Array,
        },
      ];
      expect(
        await adapter.receive({ ...delivery, locator: '43' }),
      ).toMatchObject({ kind: 'rejected', category: 'unavailable_bytes' });
      snapshot.attachments = [0, 1].map((part) => ({
        partId: String(part),
        filename: '',
        mediaType: 'application/pdf',
        bytes: Buffer.from('%PDF-' + 'x'.repeat(2500)),
      }));
      expect(
        await adapter.receive({ ...delivery, locator: '44' }),
      ).toMatchObject({ kind: 'rejected', category: 'limit' });
      binding.enabled = false;
      const priorReads = reads;
      expect(await adapter.receive(delivery)).toMatchObject({
        category: 'authentication',
      });
      expect(reads).toBe(priorReads);
      expect(await count()).toBe(1);
    });
    it('retains folder claims across failure/restart, ignores partial writes and acknowledges after ready', async () => {
      const file = join(root, 'scan.pdf');
      await writeFile(file, '%PDF-part');
      const config = {
        binding,
        directory: root,
        stabilityMs: 10,
        now: () => clock,
      };
      const adapter = new WatchFolderSourceAdapter(config);
      expect(await adapter.poll()).toEqual([]);
      clock += 11;
      await writeFile(file, '%PDF-complete');
      expect(await adapter.poll()).toEqual([]);
      expect(await count()).toBe(0);
      clock += 11;
      await adapter.poll();
      expect(await readdir(join(root, '.ingestion-claims'))).toHaveLength(1);
      allowed = false;
      clock += 11;
      expect((await adapter.poll())[0].result.kind).toBe('retry');
      const claimId = (await readdir(join(root, '.ingestion-claims')))[0];
      expect(
        await readFile(
          join(root, '.ingestion-claims', claimId, 'original'),
          'utf8',
        ),
      ).toBe('%PDF-complete');
      expect(
        await readFile(
          join(root, '.ingestion-claims', claimId, 'failure.json'),
          'utf8',
        ),
      ).not.toContain('secret');
      allowed = true;
      const restarted = new WatchFolderSourceAdapter(config);
      expect(await restarted.poll()).toEqual([]);
      clock += 11;
      expect((await restarted.poll())[0].result.kind).toBe('accepted');
      expect(await readdir(join(root, '.ingestion-processed'))).toEqual([
        claimId,
      ]);
      expect(await count()).toBe(1);
      expect(await restarted.poll()).toEqual([]);
      await writeFile(join(root, 'ignored.txt'), 'untouched');
      await symlink(join(root, 'ignored.txt'), join(root, 'symlink.pdf'));
      expect((await restarted.poll())[0].result).toMatchObject({
        kind: 'rejected',
        category: 'invalid',
      });
      binding.enabled = false;
      await writeFile(join(root, 'disabled.pdf'), '%PDF-disabled');
      expect(await restarted.poll()).toEqual([]);
      expect(await readFile(join(root, 'disabled.pdf'), 'utf8')).toBe(
        '%PDF-disabled',
      );
    });
    it('recovers real process death after receipt before folder acknowledgement without duplicate intake', async () => {
      await writeFile(join(root, 'crash.pdf'), '%PDF-crash');
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../scripts/crash-source.mjs', import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            INGESTION_CRASH_DB: databaseUrl,
            INGESTION_SOURCE_CONFIG: JSON.stringify({
              dialect,
              root,
              scope: options.scope,
              jobTarget: options.jobTarget,
              binding: { ...binding, service: undefined },
              now: clock,
            }),
          },
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      expect(child.status, child.stderr).toBe(73);
      expect(await count()).toBe(1);
      const adapter = new WatchFolderSourceAdapter({
        binding,
        directory: root,
        stabilityMs: 1,
        now: () => clock,
      });
      await adapter.poll();
      clock += 2;
      expect((await adapter.poll())[0].result.kind).toBe('duplicate');
      expect(await count()).toBe(1);
      expect(await readdir(join(root, '.ingestion-processed'))).toHaveLength(1);
    });
    it('requires authenticated vendor identity and never invokes domain actions', async () => {
      const endpoint = createVendorWebhookHandler({
        maxRequestBytes: 100,
        verify: async (request, bytes) =>
          request.headers.get('authorization') === 'verified'
            ? {
                binding,
                deliveryKey: 'vendor-42',
                deliveredAt: new Date(capturedAt),
                parts: [{ partId: 'body', mediaType: 'text/plain', bytes }],
              }
            : null,
      });
      const request = (auth: string) =>
        new Request('https://host/vendor', {
          method: 'POST',
          headers: { authorization: auth },
          body: 'vendor-original',
        });
      expect((await endpoint(request('forged'))).status).toBe(401);
      expect((await (await endpoint(request('verified'))).json()).kind).toBe(
        'accepted',
      );
      expect((await (await endpoint(request('verified'))).json()).kind).toBe(
        'duplicate',
      );
      for (const table of [
        'intake_actions',
        'intake_executions',
        'intake_proposals',
      ])
        expect(
          Number(
            (await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n,
          ),
        ).toBe(0);
    });
  });
}

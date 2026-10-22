import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertReferenceTarget,
  CREATE,
  referenceHandlers,
} from '../../reference/handlers.js';
import type { InlineInterpretation } from '../dto.js';
import { IntakeAccessDeniedError } from '../execution.js';
import type {
  IntakeExecutionOptions,
  IntakeHandler,
} from '../execution-contracts.js';
import * as models from '../models.js';
import type {
  GenerationLimits,
  ProposalConfiguration,
  ProposalGenerator,
} from '../proposal-contracts.js';
import {
  GenerationSourceStaleError,
  type IngestionOptions,
  IngestionService,
  type ReceiveInput,
} from '../server.js';
import { dropExecutionDatabase } from './postgres-cleanup.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const principal = '33333333-3333-4333-8333-333333333333';
/** The chat sender: their own captured execution principal. */
const sender = principal;
/** A service principal a host might capture for a bot-relayed message. */
const bot = '44444444-4444-4444-8444-444444444444';
const identity = { provider: 'fixture', model: 'deterministic', version: '1' };
const extraction = {
  configurationRevision: '1',
  limits: {
    maxBytes: 200000,
    maxPages: 10,
    maxPixels: 1000000,
    maxOutputBytes: 60000,
    timeoutMs: 2000,
    maxTokens: 1000,
    workerHeapMb: 64,
  },
};
const limits: GenerationLimits = {
  maxHandlers: 10,
  maxCandidates: 10,
  maxSuggestions: 10,
  maxInputBytes: 60000,
  maxOutputBytes: 60000,
  maxQueryLength: 1000,
  timeoutMs: 2000,
};
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
  'Content',
  'ContentDocument',
  'ContentAsset',
  'ContentContributionAttachment',
  'ProfileAsset',
  'PlaybookOverride',
];

/** Trusted internal sources (#4085): reference receipts bound to an owner's
 * lifecycle, the in-process inline interpretation path, and submitter-scoped
 * decisions. Deterministic generator; no model-quality claim. */
export function internalSourceSuite(
  dialect: 'sqlite' | 'postgres',
  workerType: string,
) {
  describe(`internal source receipts on ${dialect}`, () => {
    let db: DatabaseInterface;
    let admin: DatabaseInterface | undefined;
    let database: string;
    let root: string;
    let options: IngestionOptions;
    let service: IngestionService;
    let handlers: IntakeHandler[];
    let clock: Date;
    let allowed: boolean;
    let submitterGrant: boolean;
    let submitterPolicy: boolean | undefined;
    let policyReviewers: string[];
    let deniedExecutionItems: Set<string>;
    let revokedReads: Set<string>;
    let failingExecutionItems: Set<string>;
    let outageReads: Set<string>;
    let deniedThrowReads: Set<string>;
    let onCapture: (() => void) | undefined;
    let generate: ReturnType<typeof vi.fn<ProposalGenerator['generate']>>;
    const scopes = ['private', 'shared'];
    const actors = [sender, 'reviewer', 'other'];
    // Opaque delivery keys: hosts must not encode owner ids in deliveryKey.
    const deliveryKeys = new Map<string, string>();
    const opaqueKey = (owner: string) => {
      const known = deliveryKeys.get(owner);
      if (known) return known;
      const created = randomUUID();
      deliveryKeys.set(owner, created);
      return created;
    };
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'internal-'));
      clock = new Date('2026-10-20T00:00:00Z');
      allowed = true;
      submitterGrant = true;
      submitterPolicy = undefined;
      policyReviewers = ['reviewer'];
      deniedExecutionItems = new Set();
      revokedReads = new Set();
      failingExecutionItems = new Set();
      outageReads = new Set();
      deniedThrowReads = new Set();
      onCapture = undefined;
      if (dialect === 'postgres') {
        const base = process.env.DATABASE_URL;
        if (!base) throw new Error('PostgreSQL required');
        admin = await getTestDatabase({
          type: 'postgres',
          url: base,
          classes: [],
          includeSystemTables: false,
        });
        database = `ing_${randomUUID().replaceAll('-', '')}`;
        await admin.query(`CREATE DATABASE ${database}`);
        const url = new URL(base);
        url.pathname = `/${database}`;
        db = await getTestDatabase({
          type: 'postgres',
          url: url.toString(),
          classes: [...classes, workerType],
        });
      } else
        db = await getTestDatabase({
          type: 'sqlite',
          url: `file:${join(root, 'db.sqlite')}`,
          classes: [...classes, workerType],
        });
      handlers = referenceHandlers();
      handlers[0].discovery = {
        mediaTypes: ['text/plain', 'application/json'],
        references: {},
      };
      const execution: IntakeExecutionOptions = {
        handlers,
        authorize: async ({ scope, itemId, capturedCeiling }) => {
          if (failingExecutionItems.has(itemId))
            throw new Error('grant store offline');
          return {
            allowed:
              allowed &&
              !deniedExecutionItems.has(itemId) &&
              scope.tenantId === tenant &&
              scope.confidentialScopeId === 'private' &&
              actors.includes(scope.actorId),
            reviewer: scope.actorId === 'reviewer',
            submitter: submitterGrant,
            principalId: capturedCeiling.principalId,
            permissions: ['contents.create', 'contents.addAsset'],
            mutationBoundary: 'serialized',
            policy: [
              {
                version: 'app1',
                handlers: handlers.map((handler) => handler.id),
                operations: handlers.map((handler) =>
                  'model' in handler.operation
                    ? `${handler.operation.model}:${handler.operation.action}@${handler.operation.version}`
                    : handler.operation.playbookKey,
                ),
                providers: ['fixture'],
                reviewers: policyReviewers,
                access: ['private'],
                requireReview: true,
                submitterReview: true,
                maxBytes: 100000,
                leaseMs: 1000,
              },
              {
                version: 'tenant1',
                ...(submitterPolicy === undefined
                  ? {}
                  : { submitterReview: submitterPolicy }),
              },
              { version: 'source1' },
            ],
          };
        },
        assertTarget: assertReferenceTarget,
      };
      generate = vi.fn(async (input) => ({
        completion: 'complete',
        output: {
          outcome: 'proposals',
          suggestions: [
            {
              handlerId: CREATE,
              handlerVersion: '1',
              args: {
                title: 'Work order',
                body: input.evidence[0].segments[0].text,
              },
              evidence: [
                {
                  evidenceId: input.evidence[0].evidenceId,
                  location: input.evidence[0].segments[0].location,
                },
              ],
              alternatives: [],
              missingFields: [],
              explanation: 'The sender asked for this in their own message.',
            },
          ],
          splits: [],
        },
      }));
      const proposals: ProposalConfiguration = {
        version: 'app-config1',
        promptVersion: 'prompt1',
        generator: { identity, generate },
        limits: { ...limits },
      };
      options = {
        db,
        assets: await createAssetRuntime({ db, storage: join(root, 'assets') }),
        scope: {
          tenantId: tenant,
          actorId: sender,
          confidentialScopeId: 'private',
        },
        authorize: async ({ scope, operation, capturedCeiling }) => {
          const tag = String(capturedCeiling.tag ?? '');
          if (operation === 'read' && outageReads.has(tag))
            throw new Error('read grant store offline');
          if (operation === 'read' && deniedThrowReads.has(tag))
            throw new IntakeAccessDeniedError();
          return (
            allowed &&
            !(
              operation === 'read' &&
              revokedReads.has(String(capturedCeiling.tag ?? ''))
            ) &&
            scope.tenantId === tenant &&
            scopes.includes(scope.confidentialScopeId) &&
            actors.includes(scope.actorId)
          );
        },
        jobTarget: { objectType: workerType, method: 'process' },
        purgeDerived: async () => {},
        now: () => clock,
        execution,
        proposals,
      };
      service = new IngestionService(options);
      await service.assertReady();
    });
    afterEach(async () => {
      await db?.close?.();
      if (admin) {
        try {
          await dropExecutionDatabase(admin, database);
        } finally {
          await admin.close?.();
          admin = undefined;
        }
      }
      if (root) await rm(root, { recursive: true, force: true });
    });
    function as(actorId: string) {
      return new IngestionService({
        ...options,
        scope: { ...options.scope, actorId },
      });
    }
    function within(scope: Partial<IngestionOptions['scope']>) {
      return new IngestionService({
        ...options,
        scope: { ...options.scope, ...scope },
      });
    }
    function enableFeedback() {
      options.feedback = {
        version: 'feedback1',
        maxExamples: 10,
        maxScan: 100,
        maxBytes: 60000,
        minimumSimilarity: 0.2,
        authorize: async ({ scope, operation }) => {
          if (operation === 'capture') onCapture?.();
          return (
            allowed &&
            scope.tenantId === tenant &&
            scope.confidentialScopeId === 'private'
          );
        },
      };
      service = new IngestionService(options);
    }
    /** Synthetic own rows with chosen ordered ids, cloned from a real receipt
     * (fixture-owned construction; the service never sees forged authority). */
    const syntheticId = (n: number) =>
      `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
    async function cloneOwnRows(
      template: string,
      rows: Array<{ n: number; tag: string }>,
    ) {
      const [source] = (
        await db.query('SELECT * FROM intake_items WHERE id=?', template)
      ).rows as Array<Record<string, unknown>>;
      const columns = Object.keys(source);
      const value = (v: unknown) =>
        v instanceof Date
          ? v.toISOString()
          : v && typeof v === 'object'
            ? JSON.stringify(v)
            : v;
      for (let start = 0; start < rows.length; start += 100) {
        const chunk = rows.slice(start, start + 100);
        const params: unknown[] = [];
        for (const { n, tag } of chunk) {
          const data = json(source.data) as Record<string, unknown>;
          const row: Record<string, unknown> = {
            ...source,
            id: syntheticId(n),
            slug: syntheticId(n),
            delivery_key: `synthetic:${n}`,
            data: JSON.stringify({
              ...data,
              capturedCeiling: {
                ...(data.capturedCeiling as Record<string, unknown>),
                tag,
              },
            }),
          };
          for (const column of columns) params.push(value(row[column]));
        }
        await db.query(
          `INSERT INTO intake_items (${columns.join(',')}) VALUES ${chunk
            .map(() => `(${columns.map(() => '?').join(',')})`)
            .join(',')}`,
          ...params,
        );
      }
    }
    async function hiddenTemplate() {
      const input = message(randomUUID());
      input.capturedCeiling = { ...input.capturedCeiling, tag: 'template' };
      const itemId = await accepted(input);
      revokedReads.add('template');
      revokedReads.add('hidden');
      return itemId;
    }
    async function rowsFor(table: string, itemId: string) {
      return (await db.query(`SELECT * FROM ${table} WHERE item_id=?`, itemId))
        .rows;
    }
    function message(
      id: string,
      text = 'Please order two pallets of bricks for site B.',
      overrides: Partial<ReceiveInput> = {},
    ): ReceiveInput {
      return {
        sourceId: 'chat',
        sourceVersion: '1',
        deliveryKey: opaqueKey(`message:${id}`),
        deliveredAt: clock,
        parts: [
          {
            partId: 'body',
            reference: { owner: 'message', id },
            snapshot: { text },
          },
        ],
        capturedCeiling: {
          execution: {
            principalId: principal,
            permissions: ['contents.create', 'contents.addAsset'],
            handlers: handlers.map((handler) => handler.id),
            operations: handlers.map((handler) =>
              'model' in handler.operation
                ? `${handler.operation.model}:${handler.operation.action}@${handler.operation.version}`
                : handler.operation.playbookKey,
            ),
          },
        },
        retention: {
          kind: 'owner',
          owner: { kind: 'message', id },
          version: 'chat-1',
          expiresAt: new Date(clock.getTime() + 1000000),
          replayUntil: new Date(clock.getTime() + 2000000),
          acceptAfter: new Date(clock.getTime() - 1000),
        },
        limits: {
          maxBytes: 20000,
          maxParts: 3,
          maxAttempts: 3,
          leaseMs: 10000,
          maxOutputBytes: 100000,
        },
        dispatch: 'inline',
        ...overrides,
      };
    }
    async function accepted(input: ReceiveInput): Promise<string> {
      const result = await service.receive(input);
      expect(result.kind).toBe('accepted');
      if (!('itemId' in result)) throw new Error(JSON.stringify(result));
      return result.itemId;
    }
    /** PostgreSQL returns jsonb columns as objects; SQLite returns text. */
    function json(value: unknown): unknown {
      return typeof value === 'string' ? JSON.parse(value) : value;
    }
    async function count(sql: string, ...params: unknown[]): Promise<number> {
      return Number((await db.query(sql, ...params)).rows[0].n);
    }
    async function previewFirst(itemId: string, attemptId: string) {
      const [saved] = await service.previewGeneratedProposals({
        itemId,
        attemptId,
        selections: [
          {
            index: 0,
            intentionKey: 'chat:work-order',
            expectedRevision: 0,
            requestId: `preview:${itemId}`,
          },
        ],
      });
      if (saved.kind !== 'operation') throw new Error('Operation expected');
      return saved.review;
    }
    async function interpreted(id = randomUUID()) {
      const itemId = await accepted(message(id));
      const result = await service.interpretInline(itemId, {
        requestId: `interpret:${id}`,
        extraction,
      });
      if (!result.generation || !result.analysis)
        throw new Error(JSON.stringify(result));
      return { id, itemId, result, generation: result.generation };
    }
    function decision(
      review: {
        actionId: string;
        revision: number;
        reviewVersion: number;
        bindingHash: string;
      },
      requestId: string,
      decision: 'approve' | 'reject' | 'defer' | 'correct' = 'approve',
    ) {
      return {
        actionId: review.actionId,
        expectedRevision: review.revision,
        expectedReviewVersion: review.reviewVersion,
        bindingHash: review.bindingHash,
        requestId,
        decision,
      };
    }

    it('receives a referenced snapshot without preserving a blob and redacts it with its owner', async () => {
      const id = randomUUID();
      const itemId = await accepted(message(id));
      expect(await count('SELECT COUNT(*) AS n FROM assets')).toBe(0);
      const [evidence] = await service.getEvidence(itemId);
      expect(evidence).toMatchObject({
        partId: 'body',
        mediaType: 'text/plain',
        byteLength: Buffer.byteLength(
          'Please order two pallets of bricks for site B.',
        ),
      });
      expect(
        Buffer.from(await service.readEvidence(itemId, evidence.id)).toString(),
      ).toBe('Please order two pallets of bricks for site B.');
      const [row] = (
        await db.query('SELECT * FROM intake_evidence WHERE item_id=?', itemId)
      ).rows;
      expect(row.asset_id).toBeNull();
      expect(row.state).toBe('durable');
      const [item] = (
        await db.query('SELECT * FROM intake_items WHERE id=?', itemId)
      ).rows;
      expect(item.submitter_id).toBe(sender);
      expect(item.owner_key).toBe(`message:${id}`);
      // Replays keep receipt identity; a different retention mode conflicts.
      expect(await service.receive(message(id))).toMatchObject({
        kind: 'duplicate',
        itemId,
      });
      expect(
        await service.receive(
          message(id, undefined, {
            retention: {
              version: 'chat-1',
              expiresAt: new Date(clock.getTime() + 1000000),
              replayUntil: new Date(clock.getTime() + 2000000),
              acceptAfter: new Date(clock.getTime() - 1000),
            },
          }),
        ),
      ).toMatchObject({ kind: 'rejected', category: 'conflict' });
      // Another owner's receipt is untouched by this owner's deletion.
      const otherId = randomUUID();
      const otherItem = await accepted(message(otherId));
      expect(await service.expireOwned({ kind: 'message', id })).toBe(1);
      expect(await service.expireOwned({ kind: 'message', id })).toBe(0);
      await expect(service.getItem(itemId)).rejects.toThrow(
        'Intake unavailable',
      );
      expect((await service.getEvidence(otherItem)).length).toBe(1);
      const [redacted] = (
        await db.query('SELECT * FROM intake_evidence WHERE item_id=?', itemId)
      ).rows;
      expect(redacted.state).toBe('revoked');
      expect(json(redacted.data)).toEqual({});
      expect(redacted.content_hash).toBe('');
      expect(
        (
          await db.query(
            'SELECT state FROM intake_deletions WHERE item_id=?',
            itemId,
          )
        ).rows[0].state,
      ).toBe('completed');
      // A deleted owner never re-admits the same delivery as fresh work.
      expect((await service.receive(message(id))).kind).toBe('rejected');
      expect(await count('SELECT COUNT(*) AS n FROM intake_items')).toBe(2);
    });

    it('rejects malformed references, snapshots, owners and non-text inline parts without reserving a receipt', async () => {
      const invalid: Array<Partial<ReceiveInput>> = [
        {
          parts: [
            {
              partId: 'body',
              reference: { owner: '', id: 'x' },
              snapshot: { text: 'hello' },
            },
          ],
        },
        {
          parts: [
            {
              partId: 'body',
              reference: { owner: 'message', id: 'x' },
              snapshot: { text: 42 as unknown as string },
            },
          ],
        },
        {
          parts: [
            {
              partId: 'body',
              reference: { owner: 'message', id: 'x' },
              snapshot: {
                structured: ['not', 'an', 'object'] as unknown as Record<
                  string,
                  unknown
                >,
              },
            },
          ],
        },
        {
          retention: {
            kind: 'owner',
            owner: { kind: 'message:odd', id: 'x' },
            version: 'chat-1',
            expiresAt: new Date(clock.getTime() + 1000000),
            replayUntil: new Date(clock.getTime() + 2000000),
            acceptAfter: new Date(clock.getTime() - 1000),
          },
        },
        {
          parts: [
            {
              partId: 'scan',
              mediaType: 'application/pdf',
              bytes: Buffer.from('%PDF-1.4'),
            },
          ],
        },
        { dispatch: 'later' as unknown as 'inline' },
        // PostgreSQL JSON cannot store these; both engines must reject alike.
        {
          parts: [
            {
              partId: 'body',
              reference: { owner: 'message', id: 'x' },
              snapshot: { text: 'before\u0000after' },
            },
          ],
        },
        {
          parts: [
            {
              partId: 'body',
              reference: { owner: 'message', id: 'x' },
              snapshot: { text: 'lone \ud800 surrogate' },
            },
          ],
        },
        {
          parts: [
            {
              partId: 'body',
              reference: { owner: 'message', id: 'x' },
              snapshot: { text: 'lone \udc00 low' },
            },
          ],
        },
        ...[
          { owner: 'mess\u0000age', id: 'x' },
          { owner: 'message', id: 'x\ud800' },
          { owner: 'message', id: 'x\u0000' },
          { owner: 'message', id: 'x', version: 'v\u0000' },
          { owner: 'message', id: 'x', version: 'v\udfff' },
        ].map((reference) => ({
          parts: [
            {
              partId: 'body',
              reference,
              snapshot: { text: 'hello' },
            },
          ],
        })),
        ...[
          { kind: 'mess\ud800', id: 'x' },
          { kind: 'message', id: 'x\u0000' },
          { kind: 'message', id: 'x\udbff' },
        ].map((owner) => ({
          retention: {
            kind: 'owner' as const,
            owner,
            version: 'chat-1',
            expiresAt: new Date(clock.getTime() + 1000000),
            replayUntil: new Date(clock.getTime() + 2000000),
            acceptAfter: new Date(clock.getTime() - 1000),
          },
        })),
      ];
      for (const overrides of invalid)
        expect(
          await service.receive(message(randomUUID(), undefined, overrides)),
        ).toMatchObject({ kind: 'rejected', category: 'invalid' });
      expect(await count('SELECT COUNT(*) AS n FROM intake_items')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM intake_evidence')).toBe(0);
      // Distinct malformed owners would collapse onto one PostgreSQL key; the
      // owner hook refuses them instead of releasing the wrong receipts.
      for (const id of ['x\ud800', 'x\udbff', 'x\u0000'])
        await expect(
          service.expireOwned({ kind: 'message', id }),
        ).rejects.toThrow('Invalid intake owner');
      await expect(
        service.expireOwned({ kind: 'mess\udc00', id: 'x' }),
      ).rejects.toThrow('Invalid intake owner');
      const itemId = await accepted(message(randomUUID()));
      for (const requestId of ['inline\u0000', 'inline\ud800'])
        await expect(
          service.interpretInline(itemId, { requestId, extraction }),
        ).rejects.toThrow('Invalid intake identifier');
      for (const configurationRevision of ['r\u0000', 'r\udc00', ''])
        await expect(
          service.interpretInline(itemId, {
            requestId: 'valid-request',
            extraction: { ...extraction, configurationRevision },
          }),
        ).rejects.toThrow('Invalid extraction configuration');
      expect(await count('SELECT COUNT(*) AS n FROM intake_analyses')).toBe(0);
    });

    it('accepts a structured snapshot alongside a copied part and keeps the copy as a durable asset', async () => {
      const id = randomUUID();
      const itemId = await accepted(
        message(id, undefined, {
          parts: [
            {
              partId: 'body',
              reference: { owner: 'message', id, version: '3' },
              snapshot: { structured: { request: 'bricks', qty: 2 } },
            },
            {
              partId: 'note',
              parentPartId: 'body',
              mediaType: 'text/plain',
              bytes: Buffer.from('copied note'),
            },
          ],
        }),
      );
      const evidence = await service.getEvidence(itemId);
      expect(evidence.map((e) => e.mediaType).sort()).toEqual([
        'application/json',
        'text/plain',
      ]);
      const structured = evidence.find((e) => e.partId === 'body');
      if (!structured) throw new Error('Missing snapshot');
      expect(
        JSON.parse(
          Buffer.from(
            await service.readEvidence(itemId, structured.id),
          ).toString(),
        ),
      ).toEqual({ request: 'bricks', qty: 2 });
      expect(await count('SELECT COUNT(*) AS n FROM assets')).toBe(1);
      const copied = evidence.find((e) => e.partId === 'note');
      if (!copied) throw new Error('Missing copy');
      const [copiedRow] = (
        await db.query(
          'SELECT asset_id FROM intake_evidence WHERE id=?',
          copied.id,
        )
      ).rows;
      expect(copiedRow.asset_id).toBeTruthy();
      // A referenced row that gains an asset is corrupt: never served from it.
      await db.query(
        'UPDATE intake_evidence SET asset_id=? WHERE id=?',
        copiedRow.asset_id,
        structured.id,
      );
      await expect(service.readEvidence(itemId, structured.id)).rejects.toThrow(
        'Intake unavailable',
      );
      await db.query(
        'UPDATE intake_evidence SET asset_id=NULL WHERE id=?',
        structured.id,
      );
      expect(await service.expireOwned({ kind: 'message', id })).toBe(1);
      expect(await count('SELECT COUNT(*) AS n FROM assets')).toBe(0);
    });

    it('runs receive to proposals in-process without creating or delivering any queue intent', async () => {
      const { itemId, result, generation } = await interpreted();
      expect(await count('SELECT COUNT(*) AS n FROM _smrt_jobs')).toBe(0);
      const intents = (
        await db.query(
          'SELECT state, job_id, deliveries FROM intake_dispatches WHERE item_id=? ORDER BY revision',
          itemId,
        )
      ).rows;
      // Receipt reserves revision 1 (shared with extraction); interpretation is 2.
      expect(intents).toHaveLength(2);
      for (const intent of intents)
        expect(intent).toMatchObject({ state: 'completed', job_id: '' });
      expect(await service.repairDispatches()).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM _smrt_jobs')).toBe(0);
      expect(result.extraction).toMatchObject({
        revision: 1,
        state: 'completed',
        error: null,
      });
      expect(generation).toMatchObject({
        revision: 2,
        state: 'completed',
        error: null,
      });
      expect(result.analysis?.result.provider).toBe('smrt-ingestion-proposals');
      const output = result.analysis?.result.output.proposals as {
        suggestions: unknown[];
        source: { revision: number };
        provenance: { catalogDigest: string };
      };
      expect(output.suggestions).toHaveLength(1);
      expect(output.source.revision).toBe(1);
      expect(output.provenance.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await service.getItem(itemId)).toMatchObject({
        processingState: 'completed',
        analysisRevision: 2,
      });
    });

    it('replays an identical inline request and keeps job and failure semantics', async () => {
      const id = randomUUID();
      const itemId = await accepted(message(id));
      const first = await service.interpretInline(itemId, {
        requestId: `interpret:${id}`,
        extraction,
      });
      const again = await service.interpretInline(itemId, {
        requestId: `interpret:${id}`,
        extraction,
      });
      expect(again.extraction.attemptId).toBe(first.extraction.attemptId);
      expect(again.generation?.attemptId).toBe(first.generation?.attemptId);
      expect(generate).toHaveBeenCalledTimes(1);
      // A job receipt cannot borrow the inline path.
      const queued = await accepted(
        message(randomUUID(), undefined, { dispatch: 'job' }),
      );
      expect(await count('SELECT COUNT(*) AS n FROM _smrt_jobs')).toBe(1);
      await expect(
        service.interpretInline(queued, { requestId: 'q', extraction }),
      ).rejects.toThrow('Inline interpretation requires an inline receipt');
      // Provider failure keeps the job path's safe category; no exception text.
      generate.mockRejectedValueOnce(new Error('secret provider detail'));
      const failed = await service.interpretInline(
        await accepted(message(randomUUID())),
        { requestId: randomUUID(), extraction },
      );
      expect(failed.generation).toMatchObject({
        state: 'partial',
        error: 'unavailable',
      });
      expect(failed.analysis?.result.error).toBe('unavailable');
      expect(JSON.stringify(failed)).not.toContain('secret provider detail');
      // Revoked process access denies before any stage runs.
      allowed = false;
      await expect(
        service.interpretInline(itemId, {
          requestId: randomUUID(),
          extraction,
        }),
      ).rejects.toThrow('Intake unavailable');
    });

    it('lets the recorded submitter list and decide only their own proposals and applies once under live grants', async () => {
      const mine = await interpreted();
      const review = await previewFirst(mine.itemId, mine.generation.attemptId);
      // Another authenticated actor submitted a different item.
      const theirs = await (async () => {
        const other = as('other');
        const itemId = (await other.receive(message(randomUUID()))) as {
          itemId: string;
        };
        await other.interpretInline(itemId.itemId, {
          requestId: randomUUID(),
          extraction,
        });
        return itemId.itemId;
      })();
      const own = await service.listOwnProposals();
      expect(own.items.map((entry) => entry.item.id)).toEqual([mine.itemId]);
      expect(own.items[0].reviews?.actions[0].review).toMatchObject({
        actionId: review.actionId,
        state: 'waiting_review',
      });
      expect(own.nextCursor).toBeUndefined();
      expect(
        (await as('other').listOwnProposals()).items.map((e) => e.item.id),
      ).toEqual([theirs]);
      expect((await as('reviewer').listOwnProposals()).items).toEqual([]);
      // The submitter is not a reviewer: the inbox decision is denied...
      await expect(
        service.submitDecision(decision(review, 'inbox-approve')),
      ).rejects.toThrow('Intake unavailable');
      // ...and nobody else can decide the submitter's proposal as its submitter.
      await expect(
        as('other').submitOwnDecision(decision(review, 'other-approve')),
      ).rejects.toThrow('Intake unavailable');
      await expect(
        as('reviewer').submitOwnDecision(decision(review, 'reviewer-own')),
      ).rejects.toThrow('Intake unavailable');
      await expect(
        service.submitOwnDecision(decision(review, 'correct-own', 'correct')),
      ).rejects.toThrow('Invalid decision');
      expect(
        (await db.query('SELECT id FROM intake_review_decisions')).rows,
      ).toHaveLength(0);
      const approved = await service.submitOwnDecision(
        decision(review, 'own-approve'),
      );
      expect(approved.state).toBe('authorized');
      const [recorded] = (
        await db.query('SELECT data FROM intake_review_decisions')
      ).rows;
      expect(json(recorded.data)).toMatchObject({
        reviewer: sender,
        kind: 'human',
      });
      // Identical replay returns the same review; changed content conflicts.
      expect(
        (await service.submitOwnDecision(decision(review, 'own-approve')))
          .actionId,
      ).toBe(review.actionId);
      await expect(
        service.submitOwnDecision(decision(review, 'own-approve', 'reject')),
      ).rejects.toThrow('Decision request conflict');
      const applied = await service.applyAction(review.actionId);
      expect(applied.state).toBe('succeeded');
      expect((await service.applyAction(review.actionId)).resultDigest).toBe(
        applied.resultDigest,
      );
      expect(await count('SELECT COUNT(*) AS n FROM contents')).toBe(1);
      const [content] = (
        await db.query('SELECT title, body, tenant_id FROM contents')
      ).rows;
      expect(content).toMatchObject({
        title: 'Work order',
        body: 'Please order two pallets of bricks for site B.',
        tenant_id: tenant,
      });
      expect(
        (await service.listOwnProposals()).items[0].reviews?.actions[0].review
          .state,
      ).toBe('succeeded');
    });

    it('denies submitter decisions without a live host grant or an application policy opt-in', async () => {
      const mine = await interpreted();
      const review = await previewFirst(mine.itemId, mine.generation.attemptId);
      submitterGrant = false;
      await expect(
        service.submitOwnDecision(decision(review, 'no-grant')),
      ).rejects.toThrow('Intake unavailable');
      submitterGrant = true;
      submitterPolicy = false;
      await expect(
        service.submitOwnDecision(decision(review, 'no-policy')),
      ).rejects.toThrow('Intake unavailable');
      submitterPolicy = undefined;
      expect(
        (await db.query('SELECT id FROM intake_review_decisions')).rows,
      ).toHaveLength(0);
      expect(
        (await service.submitOwnDecision(decision(review, 'ok', 'defer')))
          .state,
      ).toBe('deferred');
      // Own listing is bounded and paginated by item identity.
      await interpreted();
      const page = await service.listOwnProposals({ limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeTruthy();
      const rest = await service.listOwnProposals({
        limit: 1,
        cursor: page.nextCursor,
      });
      expect(rest.items).toHaveLength(1);
      expect(rest.nextCursor).toBeUndefined();
      expect(rest.items[0].item.id).not.toBe(page.items[0].item.id);
      await expect(service.listOwnProposals({ limit: 51 })).rejects.toThrow(
        'Invalid review page',
      );
      // Owner deletion removes the submission from the own list immediately.
      expect(await service.expireOwned({ kind: 'message', id: mine.id })).toBe(
        1,
      );
      expect(
        (await service.listOwnProposals()).items.map((e) => e.item.id),
      ).not.toContain(mine.itemId);
    });

    it('redacts every ledger table and severs the owner and submitter links after owner deletion', async () => {
      const mine = await interpreted();
      const review = await previewFirst(mine.itemId, mine.generation.attemptId);
      await service.submitOwnDecision(decision(review, 'before-delete'));
      const applied = await service.applyAction(review.actionId);
      expect(applied.state).toBe('succeeded');
      const tables = [
        'intake_evidence',
        'intake_analyses',
        'intake_analysis_attempts',
        'intake_dispatches',
        'intake_actions',
        'intake_proposals',
        'intake_review_decisions',
      ];
      for (const table of tables)
        expect((await rowsFor(table, mine.itemId)).length).toBeGreaterThan(0);
      expect(await service.expireOwned({ kind: 'message', id: mine.id })).toBe(
        1,
      );
      for (const table of tables)
        for (const row of await rowsFor(table, mine.itemId))
          expect(json(row.data), table).toEqual({});
      const [item] = (
        await db.query('SELECT * FROM intake_items WHERE id=?', mine.itemId)
      ).rows;
      expect(item).toMatchObject({
        visibility: 'expired',
        submitter_id: '',
        owner_key: '',
        trace_id: '',
      });
      expect(Object.keys(json(item.data) as object)).toEqual([
        'capturedCeiling',
      ]);
      // No digest over actor, owner, text or arguments survives and the
      // delivery key is opaque. The ceiling (with its principal) is retained
      // for post-redaction reconciliation; nothing else carries the sender.
      expect(item.payload_digest).toBe('redacted');
      expect(item.scope_digest).toBe('redacted');
      expect(String(item.delivery_key)).not.toContain(mine.id);
      expect(String(item.delivery_key)).not.toContain(sender);
      const ceiling = (json(item.data) as Record<string, any>).capturedCeiling;
      expect(ceiling.execution.principalId).toBe(sender);
      expect(Object.keys(json(item.data) as object)).toEqual([
        'capturedCeiling',
      ]);
      for (const [table, column] of [
        ['intake_analyses', 'input_digest'],
        ['intake_analysis_attempts', 'output_digest'],
        ['intake_proposals', 'binding_hash'],
        ['intake_review_decisions', 'binding_hash'],
        ['intake_executions', 'binding_hash'],
      ]) {
        const rows = await rowsFor(table, mine.itemId);
        expect(rows.length, table).toBeGreaterThan(0);
        for (const row of rows) expect(row[column], table).toBe('redacted');
      }
      for (const row of await rowsFor('intake_evidence', mine.itemId))
        expect(row.content_hash).toBe('');
      // The successful result digest stays as the documented replay tombstone.
      const [action] = await rowsFor('intake_actions', mine.itemId);
      expect(action.result_digest).toBe(applied.resultDigest);
      expect(await service.applyAction(review.actionId)).toMatchObject({
        state: 'succeeded',
        resultDigest: applied.resultDigest,
        tombstone: true,
      });
      // Severed links: neither the owner hook nor the own list can find it again.
      expect(await service.expireOwned({ kind: 'message', id: mine.id })).toBe(
        0,
      );
      expect(
        (await service.listOwnProposals()).items.map((e) => e.item.id),
      ).toEqual([]);
      await expect(service.listReviews(mine.itemId)).resolves.toMatchObject({
        actions: [{ review: { state: 'expired', display: {} } }],
      });
    });

    it('fails closed on a tampered referenced snapshot and holds the inline lease like a job until expiry', async () => {
      const id = randomUUID();
      const itemId = await accepted(message(id));
      const [evidence] = await service.getEvidence(itemId);
      const [row] = await rowsFor('intake_evidence', itemId);
      const data = json(row.data) as Record<string, unknown>;
      // Same length, different bytes: only the hash can catch it.
      const sameLength = 'Please order two pallets of bricks for site C.';
      expect(Buffer.byteLength(sameLength)).toBe(evidence.byteLength);
      await db.query(
        'UPDATE intake_evidence SET data=? WHERE id=?',
        JSON.stringify({ ...data, snapshot: sameLength }),
        row.id,
      );
      await expect(service.readEvidence(itemId, evidence.id)).rejects.toThrow(
        'Intake integrity',
      );
      await db.query(
        'UPDATE intake_evidence SET data=? WHERE id=?',
        JSON.stringify({ ...data, snapshot: 'short' }),
        row.id,
      );
      await expect(service.readEvidence(itemId, evidence.id)).rejects.toThrow(
        'Intake integrity',
      );
      await db.query(
        'UPDATE intake_evidence SET data=? WHERE id=?',
        JSON.stringify({ sourceReference: data.sourceReference }),
        row.id,
      );
      await expect(service.readEvidence(itemId, evidence.id)).rejects.toThrow(
        'Intake unavailable',
      );
      await db.query(
        'UPDATE intake_evidence SET data=? WHERE id=?',
        JSON.stringify({ ...data, snapshot: 'short' }),
        row.id,
      );
      // An uncategorized failure inside the stage propagates, exactly as a
      // job worker would crash: the attempt stays running under its lease.
      const requestId = `interpret:${id}`;
      await expect(
        service.interpretInline(itemId, { requestId, extraction }),
      ).rejects.toThrow('Intake integrity');
      expect(generate).not.toHaveBeenCalled();
      let attempts = await rowsFor('intake_analysis_attempts', itemId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].state).toBe('running');
      expect(await service.getItem(itemId)).toMatchObject({
        processingState: 'running',
        analysisRevision: 1,
      });
      await expect(
        service.interpretInline(itemId, { requestId, extraction }),
      ).rejects.toThrow('Inline interpretation busy');
      expect(await count('SELECT COUNT(*) AS n FROM _smrt_jobs')).toBe(0);
      // After the lease expires the same request claims a fresh fenced attempt.
      clock = new Date(clock.getTime() + 10001);
      await expect(
        service.interpretInline(itemId, { requestId, extraction }),
      ).rejects.toThrow('Intake integrity');
      attempts = await rowsFor('intake_analysis_attempts', itemId);
      expect(attempts.map((a) => a.state).sort()).toEqual([
        'running',
        'superseded',
      ]);
      expect(await count('SELECT COUNT(*) AS n FROM _smrt_jobs')).toBe(0);
    });

    it('scopes own listings and owner expiry to the authenticated tenant and confidential scope', async () => {
      const mine = await interpreted();
      const shared = within({ confidentialScopeId: 'shared' });
      const sharedReceipt = await shared.receive(
        message(mine.id, undefined, {
          deliveryKey: opaqueKey(`shared:${mine.id}`),
        }),
      );
      if (!('itemId' in sharedReceipt)) throw new Error('Receipt failed');
      const foreignTenant = within({
        tenantId: '22222222-2222-4222-8222-222222222222',
      });
      expect((await foreignTenant.listOwnProposals()).items).toEqual([]);
      expect(
        (await shared.listOwnProposals()).items.map((e) => e.item.id),
      ).toEqual([sharedReceipt.itemId]);
      expect(
        (await service.listOwnProposals()).items.map((e) => e.item.id),
      ).toEqual([mine.itemId]);
      expect(
        await foreignTenant.expireOwned({ kind: 'message', id: mine.id }),
      ).toBe(0);
      // Each confidential scope's service releases its own receipts.
      expect(await service.expireOwned({ kind: 'message', id: mine.id })).toBe(
        1,
      );
      expect(await shared.getItem(sharedReceipt.itemId)).toMatchObject({
        receiptState: 'ready',
      });
      expect(await shared.expireOwned({ kind: 'message', id: mine.id })).toBe(
        1,
      );
      await expect(shared.getItem(sharedReceipt.itemId)).rejects.toThrow(
        'Intake unavailable',
      );
    });

    it('fills own pages from readable items only and never names a hidden item in the cursor', async () => {
      const created: Array<{ itemId: string; tag: string }> = [];
      for (const tag of ['t1', 't2', 't3']) {
        const input = message(randomUUID());
        input.capturedCeiling = { ...input.capturedCeiling, tag };
        created.push({ itemId: await accepted(input), tag });
      }
      const [a, b, c] = created.sort((x, y) => (x.itemId < y.itemId ? -1 : 1));
      revokedReads.add(b.tag);
      const ids = (page: { items: Array<{ item: { id: string } }> }) =>
        page.items.map((entry) => entry.item.id);
      const both = await service.listOwnProposals({ limit: 2 });
      expect(ids(both)).toEqual([a.itemId, c.itemId]);
      expect(both.nextCursor).toBeUndefined();
      expect(JSON.stringify(both)).not.toContain(b.itemId);
      const first = await service.listOwnProposals({ limit: 1 });
      expect(ids(first)).toEqual([a.itemId]);
      expect(first.nextCursor).toBe(a.itemId);
      const second = await service.listOwnProposals({
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(ids(second)).toEqual([c.itemId]);
      expect(second.nextCursor).toBeUndefined();
      expect(JSON.stringify([first, second])).not.toContain(b.itemId);
      // A cursor is only offered when a further readable item exists.
      revokedReads.add(c.tag);
      const tail = await service.listOwnProposals({ limit: 1 });
      expect(ids(tail)).toEqual([a.itemId]);
      expect(tail.nextCursor).toBeUndefined();
      // An all-unreadable page is empty and offers no cursor.
      revokedReads.add(a.tag);
      for (const limit of [1, 2, 50]) {
        const none = await service.listOwnProposals({ limit });
        expect(none).toEqual({ items: [] });
      }
    });

    it('pages readable own rows across the 50-row batch boundary with a confirmed cursor', async () => {
      const template = await hiddenTemplate();
      await cloneOwnRows(template, [
        ...Array.from({ length: 49 }, (_, i) => ({ n: i + 1, tag: 'hidden' })),
        { n: 50, tag: 'visible' },
        { n: 51, tag: 'visible' },
      ]);
      const first = await service.listOwnProposals({ limit: 1 });
      expect(first.items.map((e) => e.item.id)).toEqual([syntheticId(50)]);
      expect(first.nextCursor).toBe(syntheticId(50));
      const second = await service.listOwnProposals({
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.items.map((e) => e.item.id)).toEqual([syntheticId(51)]);
      expect(second.nextCursor).toBeUndefined();
      const all = await service.listOwnProposals({ limit: 50 });
      expect(all.items.map((e) => e.item.id)).toEqual([
        syntheticId(50),
        syntheticId(51),
      ]);
      expect(all.nextCursor).toBeUndefined();
      for (const page of [first, second, all])
        for (let n = 1; n < 50; n++)
          expect(JSON.stringify(page)).not.toContain(syntheticId(n));
    });

    it('fails closed after skipping 1000 hidden own rows instead of returning a short page or cursor', async () => {
      const template = await hiddenTemplate();
      // 998 synthetic hidden rows sort first, then one readable row, then the
      // hidden template: 999 hidden rows in total still list the readable one.
      await cloneOwnRows(template, [
        ...Array.from({ length: 998 }, (_, i) => ({ n: i + 1, tag: 'hidden' })),
        { n: 2000, tag: 'visible' },
      ]);
      const page = await service.listOwnProposals();
      expect(page).toEqual({
        items: [
          expect.objectContaining({
            item: expect.objectContaining({ id: syntheticId(2000) }),
          }),
        ],
      });
      const single = await service.listOwnProposals({ limit: 1 });
      expect(single.items.map((e) => e.item.id)).toEqual([syntheticId(2000)]);
      expect(single.nextCursor).toBeUndefined();
      // The 1000th hidden row reaches the ceiling: an error, never a cursor.
      await cloneOwnRows(template, [{ n: 999, tag: 'hidden' }]);
      await expect(service.listOwnProposals()).rejects.toThrow(
        'Own proposal scan limit',
      );
      await expect(service.listOwnProposals({ limit: 1 })).rejects.toThrow(
        'Own proposal scan limit',
      );
    });

    it('propagates a failing grant store but hides an explicit typed denial', async () => {
      const visible = await interpreted();
      const input = message(randomUUID());
      input.capturedCeiling = { ...input.capturedCeiling, tag: 'grants' };
      const other = await accepted(input);
      outageReads.add('grants');
      await expect(service.listOwnProposals()).rejects.toThrow(
        'read grant store offline',
      );
      outageReads.clear();
      deniedThrowReads.add('grants');
      const page = await service.listOwnProposals();
      expect(page.items.map((e) => e.item.id)).toEqual([visible.itemId]);
      expect(JSON.stringify(page)).not.toContain(other);
    });

    it('marks an item unavailable when the reference host target check throws, without host text', async () => {
      const first = await interpreted();
      const second = await interpreted();
      const contentIds: string[] = [];
      for (const entry of [first, second]) {
        const review = await previewFirst(
          entry.itemId,
          entry.generation.attemptId,
        );
        await service.submitOwnDecision(
          decision(review, `apply:${entry.itemId}`),
        );
        const applied = await service.applyAction(review.actionId);
        expect(applied.state).toBe('succeeded');
        contentIds.push(String(applied.result?.contentId));
      }
      // The first target leaves this confidential scope: the unmodified
      // reference host now throws a plain 'Target unavailable' Error for it.
      await db.query(
        "UPDATE contents SET context='elsewhere' WHERE id=?",
        contentIds[0],
      );
      await expect(service.listReviews(first.itemId)).rejects.toThrow(
        'Target unavailable',
      );
      const page = await service.listOwnProposals();
      const entries = new Map(page.items.map((e) => [e.item.id, e]));
      expect(entries.get(first.itemId)).toMatchObject({
        reviews: null,
        unavailable: true,
      });
      expect(entries.get(second.itemId)?.reviews?.actions[0].review.state).toBe(
        'succeeded',
      );
      expect(JSON.stringify(page)).not.toContain('Target unavailable');
      expect(JSON.stringify(page)).not.toContain(contentIds[0]);
    });

    it('rejects malformed cursors before they reach SQL', async () => {
      const mine = await interpreted();
      for (const cursor of [
        '-'.repeat(36),
        'z'.repeat(36),
        `${mine.itemId}x`,
      ]) {
        await expect(service.listOwnProposals({ cursor })).rejects.toThrow(
          'Invalid review page',
        );
        await expect(
          service.listReviews(mine.itemId, { cursor }),
        ).rejects.toThrow('Invalid review page');
      }
    });

    it('replays one inline request raced by an identical concurrent call', async () => {
      const id = randomUUID();
      const itemId = await accepted(message(id));
      const request = { requestId: `race:${id}`, extraction };
      let held: Promise<InlineInterpretation> | undefined;
      // The first call is held between its replay lookup and its append while
      // the identical second call runs to completion.
      const racing: IngestionService = new IngestionService({
        ...options,
        checkpoint: async (name) => {
          if (name !== 'inline:replay-miss' || held) return;
          held = racing.interpretInline(itemId, request);
          await held;
        },
      });
      const [first, second] = await Promise.all([
        racing.interpretInline(itemId, request),
        (async () => {
          while (!held) await new Promise((resolve) => setTimeout(resolve, 5));
          return held;
        })(),
      ]);
      expect(first.extraction.attemptId).toBe(second.extraction.attemptId);
      expect(first.generation?.attemptId).toBe(second.generation?.attemptId);
      expect(first.generation?.state).toBe('completed');
      expect(first.analysis?.attemptId).toBe(second.analysis?.attemptId);
      expect(generate).toHaveBeenCalledTimes(1);
      expect((await rowsFor('intake_analyses', itemId)).length).toBe(2);
      expect(await count('SELECT COUNT(*) AS n FROM _smrt_jobs')).toBe(0);
    });

    it('refuses an inline interpretation whose pinned extraction a concurrent reprocess superseded', async () => {
      const id = randomUUID();
      const itemId = await accepted(message(id));
      let held: Promise<InlineInterpretation> | undefined;
      // Hold the first call after it prepared against extraction revision 1;
      // a different request reprocesses and interprets in the meantime.
      const racing: IngestionService = new IngestionService({
        ...options,
        checkpoint: async (name) => {
          if (name !== 'inline:prepared' || held) return;
          held = racing.interpretInline(itemId, {
            requestId: `later:${id}`,
            extraction,
          });
          await held;
        },
      });
      await expect(
        racing.interpretInline(itemId, {
          requestId: `earlier:${id}`,
          extraction,
        }),
      ).rejects.toThrow(GenerationSourceStaleError);
      const later = await held;
      expect(later?.generation?.state).toBe('completed');
      const analyses = await rowsFor('intake_analyses', itemId);
      expect(
        analyses.map((row) => Number(row.revision)).sort((a, b) => a - b),
      ).toEqual([1, 2, 3]);
      expect(
        analyses.some(
          (row) =>
            (json(row.data) as Record<string, unknown>).requestKey ===
            `inline:interpret:earlier:${id}`,
        ),
      ).toBe(false);
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it('refuses a self-decision whose effect would run as a different captured principal', async () => {
      const input = message(randomUUID());
      const execution = input.capturedCeiling.execution as Record<
        string,
        unknown
      >;
      input.capturedCeiling = {
        ...input.capturedCeiling,
        execution: { ...execution, principalId: bot },
      };
      const itemId = await accepted(input);
      const run = await service.interpretInline(itemId, {
        requestId: randomUUID(),
        extraction,
      });
      if (!run.generation) throw new Error('Generation missing');
      const review = await previewFirst(itemId, run.generation.attemptId);
      expect(
        (await service.listOwnProposals()).items.map((e) => e.item.id),
      ).toEqual([itemId]);
      await expect(
        service.submitOwnDecision(decision(review, 'bot-self')),
      ).rejects.toThrow('Intake unavailable');
      expect(
        (await db.query('SELECT id FROM intake_review_decisions')).rows,
      ).toHaveLength(0);
      // A reviewer can still approve it; the effect then runs as the bot.
      await as('reviewer').submitDecision(decision(review, 'bot-review'));
      expect((await service.applyAction(review.actionId)).state).toBe(
        'succeeded',
      );
    });

    it('rechecks at apply that a self-decision authorizes only its own principal', async () => {
      const mine = await interpreted();
      const review = await previewFirst(mine.itemId, mine.generation.attemptId);
      await service.submitOwnDecision(decision(review, 'self'));
      // Fixture-only tampering: the receipt's captured principal no longer
      // matches the submitter after the decision was recorded.
      const [item] = (
        await db.query('SELECT data FROM intake_items WHERE id=?', mine.itemId)
      ).rows;
      const data = json(item.data) as Record<string, any>;
      data.capturedCeiling.execution.principalId = bot;
      await db.query(
        'UPDATE intake_items SET data=? WHERE id=?',
        JSON.stringify(data),
        mine.itemId,
      );
      await expect(service.applyAction(review.actionId)).rejects.toThrow(
        'Approval required',
      );
      expect(await count('SELECT COUNT(*) AS n FROM contents')).toBe(0);
    });

    it('marks a reviewer approving their own submission as a self-decision', async () => {
      const reviewer = as('reviewer');
      const id = randomUUID();
      const receipt = await reviewer.receive(message(id));
      if (!('itemId' in receipt)) throw new Error('Receipt failed');
      const run = await reviewer.interpretInline(receipt.itemId, {
        requestId: randomUUID(),
        extraction,
      });
      if (!run.generation) throw new Error('Generation missing');
      const [saved] = await reviewer.previewGeneratedProposals({
        itemId: receipt.itemId,
        attemptId: run.generation.attemptId,
        selections: [
          {
            index: 0,
            intentionKey: 'reviewer-own',
            expectedRevision: 0,
            requestId: `preview:${receipt.itemId}`,
          },
        ],
      });
      if (saved.kind !== 'operation') throw new Error('Operation expected');
      await reviewer.submitDecision(decision(saved.review, 'reviewer-self'));
      const [recorded] = (
        await db.query('SELECT data FROM intake_review_decisions')
      ).rows;
      expect(json(recorded.data)).toMatchObject({
        reviewer: 'reviewer',
        mode: 'review',
        selfDecision: true,
      });
    });

    it('reports a receipt revoked before acknowledgement as expired, never accepted', async () => {
      for (const boundary of ['evidence', 'ready']) {
        const id = randomUUID();
        const racing = new IngestionService({
          ...options,
          checkpoint: async (name) => {
            if (name === boundary)
              await service.expireOwned({ kind: 'message', id });
          },
        });
        expect(await racing.receive(message(id)), boundary).toEqual({
          kind: 'rejected',
          category: 'expired',
        });
        const [row] = (
          await db.query(
            'SELECT * FROM intake_items WHERE delivery_key=?',
            opaqueKey(`message:${id}`),
          )
        ).rows;
        expect(row.visibility, boundary).toBe('expired');
        for (const evidence of await rowsFor('intake_evidence', String(row.id)))
          expect(json(evidence.data), boundary).toEqual({});
        // The deleted delivery stays refused on replay.
        expect((await service.receive(message(id))).kind).toBe('rejected');
      }
    });

    it('never leaves a deliverable intent for an inline receipt at any stage', async () => {
      const id = randomUUID();
      const itemId = await accepted(message(id));
      const undelivered = async () => {
        for (const intent of await rowsFor('intake_dispatches', itemId))
          expect(intent).toMatchObject({ state: 'completed', job_id: '' });
        expect(await service.repairDispatches()).toBe(0);
        expect(await count('SELECT COUNT(*) AS n FROM _smrt_jobs')).toBe(0);
      };
      await undelivered();
      expect(await service.receive(message(id))).toMatchObject({
        kind: 'duplicate',
        itemId,
      });
      await undelivered();
      await service.interpretInline(itemId, {
        requestId: `interpret:${id}`,
        extraction,
      });
      await undelivered();
      expect((await rowsFor('intake_dispatches', itemId)).length).toBe(2);
    });

    it('refuses a feedback write across which submitter review authority widens', async () => {
      enableFeedback();
      const mine = await interpreted();
      const review = await previewFirst(mine.itemId, mine.generation.attemptId);
      const binding = {
        itemId: mine.itemId,
        actionId: review.actionId,
        expectedRevision: review.revision,
        expectedReviewVersion: review.reviewVersion,
        bindingHash: review.bindingHash,
      };
      const reviewer = as('reviewer');
      submitterPolicy = false;
      onCapture = () => {
        submitterPolicy = undefined;
      };
      await expect(
        reviewer.recordFeedback({
          ...binding,
          judgment: 'correct',
          requestId: 'widen',
        }),
      ).rejects.toThrow('Feedback cannot widen policy');
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM intake_feedback WHERE request_key='judgment:widen'",
        ),
      ).toBe(0);
      // A stable policy records normally.
      onCapture = undefined;
      await expect(
        reviewer.recordFeedback({
          ...binding,
          judgment: 'correct',
          requestId: 'steady',
        }),
      ).resolves.toMatchObject({ id: expect.any(String) });
    });

    it('propagates non-denial failures from a readable submission instead of marking it unavailable', async () => {
      const mine = await interpreted();
      await previewFirst(mine.itemId, mine.generation.attemptId);
      failingExecutionItems.add(mine.itemId);
      await expect(service.listOwnProposals()).rejects.toThrow(
        'grant store offline',
      );
      failingExecutionItems.clear();
      deniedExecutionItems.add(mine.itemId);
      expect((await service.listOwnProposals()).items).toEqual([
        expect.objectContaining({ reviews: null, unavailable: true }),
      ]);
    });

    it('omits a submission whose item-level read is revoked without disclosing its identity', async () => {
      const visible = await interpreted();
      const revokedId = randomUUID();
      const input = message(revokedId);
      input.capturedCeiling = { ...input.capturedCeiling, tag: 'revocable' };
      const revokedItem = await accepted(input);
      await service.interpretInline(revokedItem, {
        requestId: randomUUID(),
        extraction,
      });
      expect(
        (await service.listOwnProposals()).items.map((e) => e.item.id).sort(),
      ).toEqual([visible.itemId, revokedItem].sort());
      revokedReads.add('revocable');
      const page = await service.listOwnProposals();
      expect(page.items.map((e) => e.item.id)).toEqual([visible.itemId]);
      expect(page.items.some((e) => e.unavailable)).toBe(false);
      expect(page.nextCursor).toBeUndefined();
      expect(JSON.stringify(page)).not.toContain(revokedItem);
      await expect(service.getItem(revokedItem)).rejects.toThrow(
        'Intake unavailable',
      );
      revokedReads.clear();
      expect(
        (await service.listOwnProposals()).items.map((e) => e.item.id).sort(),
      ).toEqual([visible.itemId, revokedItem].sort());
    });

    it('marks an unreadable submission unavailable without hiding the others and labels self-decisions', async () => {
      enableFeedback();
      const first = await interpreted();
      const second = await interpreted();
      const firstReview = await previewFirst(
        first.itemId,
        first.generation.attemptId,
      );
      const secondReview = await previewFirst(
        second.itemId,
        second.generation.attemptId,
      );
      deniedExecutionItems.add(second.itemId);
      const page = await service.listOwnProposals();
      const entries = new Map(page.items.map((e) => [e.item.id, e]));
      expect([...entries.keys()].sort()).toEqual(
        [first.itemId, second.itemId].sort(),
      );
      expect(
        entries.get(first.itemId)?.reviews?.actions[0].review,
      ).toMatchObject({
        actionId: firstReview.actionId,
        state: 'waiting_review',
      });
      expect(entries.get(second.itemId)).toMatchObject({
        reviews: null,
        unavailable: true,
      });
      expect(JSON.stringify(entries.get(second.itemId))).not.toContain(CREATE);
      expect(JSON.stringify(entries.get(second.itemId))).not.toContain(
        secondReview.actionId,
      );
      deniedExecutionItems.delete(second.itemId);
      await service.submitOwnDecision(decision(firstReview, 'self'));
      await as('reviewer').submitDecision(decision(secondReview, 'inbox'));
      const decisions = (
        await db.query(
          'SELECT action_id, data FROM intake_review_decisions ORDER BY created_at',
        )
      ).rows.map((row) => ({
        actionId: row.action_id,
        ...(json(row.data) as Record<string, unknown>),
      }));
      expect(decisions).toEqual([
        expect.objectContaining({
          actionId: firstReview.actionId,
          kind: 'human',
          reviewer: sender,
          mode: 'review_own',
          selfDecision: true,
        }),
        expect.objectContaining({
          actionId: secondReview.actionId,
          kind: 'human',
          reviewer: 'reviewer',
          mode: 'review',
          selfDecision: false,
        }),
      ]);
      const feedback = (
        await db.query(
          "SELECT data FROM intake_feedback WHERE kind='action_decision' ORDER BY created_at",
        )
      ).rows.map((row) => json(row.data) as Record<string, unknown>);
      expect(feedback).toEqual([
        expect.objectContaining({
          reviewer: sender,
          decisionMode: 'review_own',
          selfDecision: true,
        }),
        expect.objectContaining({
          reviewer: 'reviewer',
          decisionMode: 'review',
          selfDecision: false,
        }),
      ]);
    });
  });
}

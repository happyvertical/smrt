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
  type IngestionOptions,
  IngestionService,
  type ReceiveInput,
} from '../server.js';
import { dropExecutionDatabase } from './postgres-cleanup.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const principal = '33333333-3333-4333-8333-333333333333';
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
    let generate: ReturnType<typeof vi.fn<ProposalGenerator['generate']>>;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'internal-'));
      clock = new Date('2026-10-20T00:00:00Z');
      allowed = true;
      submitterGrant = true;
      submitterPolicy = undefined;
      policyReviewers = ['reviewer'];
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
        authorize: async ({ scope }) => ({
          allowed:
            allowed &&
            scope.tenantId === tenant &&
            scope.confidentialScopeId === 'private' &&
            ['sender', 'reviewer', 'other'].includes(scope.actorId),
          reviewer: scope.actorId === 'reviewer',
          submitter: submitterGrant,
          principalId: principal,
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
        }),
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
          actorId: 'sender',
          confidentialScopeId: 'private',
        },
        authorize: async ({ scope }) =>
          allowed &&
          scope.tenantId === tenant &&
          scope.confidentialScopeId === 'private' &&
          ['sender', 'reviewer', 'other'].includes(scope.actorId),
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
    function message(
      id: string,
      text = 'Please order two pallets of bricks for site B.',
      overrides: Partial<ReceiveInput> = {},
    ): ReceiveInput {
      return {
        sourceId: 'chat',
        sourceVersion: '1',
        deliveryKey: `message:${id}`,
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
      expect(item.submitter_id).toBe('sender');
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
      ];
      for (const overrides of invalid)
        expect(
          await service.receive(message(randomUUID(), undefined, overrides)),
        ).toMatchObject({ kind: 'rejected', category: 'invalid' });
      expect(await count('SELECT COUNT(*) AS n FROM intake_items')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM intake_evidence')).toBe(0);
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
      expect(own.items[0].reviews.actions[0].review).toMatchObject({
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
        reviewer: 'sender',
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
        (await service.listOwnProposals()).items[0].reviews.actions[0].review
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
  });
}

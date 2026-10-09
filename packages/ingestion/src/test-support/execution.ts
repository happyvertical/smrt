import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { Contents } from '@happyvertical/smrt-content';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  type JobExecutionContext,
  McpTaskStore,
} from '@happyvertical/smrt-jobs';
import { createTaskRunner } from '@happyvertical/smrt-jobs/runner';
import { definePlaybook, resolvePlaybook } from '@happyvertical/smrt-playbooks';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACH,
  assertReferenceTarget,
  CONTENT,
  CREATE,
  DOCUMENT,
  referenceHandlers,
} from '../../reference/handlers.js';
import { continueIntakeReview, intakeBindingDigest } from '../execution.js';
import type {
  IntakeExecutionOptions,
  IntakeHandler,
  OperationHandler,
  PlanHandler,
  ProposalReview,
} from '../execution-contracts.js';
import * as models from '../models.js';
import {
  type IngestionOptions,
  IngestionService,
  type ReceiveInput,
} from '../server.js';
import { dropExecutionDatabase } from './postgres-cleanup.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const principal = '33333333-3333-4333-8333-333333333333';
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
let hostOptions: IngestionOptions;
export async function runReviewJob(
  db: DatabaseInterface,
  input: { actionId: string },
  context?: JobExecutionContext,
) {
  if (!context?.task) throw new Error('Durable task context required');
  return continueIntakeReview(
    new IngestionService({ ...hostOptions, db }),
    input.actionId,
    context.task,
  );
}
export function executionSuite(
  dialect: 'sqlite' | 'postgres',
  workerType: string,
) {
  describe(`authoritative execution on ${dialect}`, () => {
    let db: DatabaseInterface;
    let peer: DatabaseInterface;
    let admin: DatabaseInterface | undefined;
    let dbName: string;
    let root: string;
    let options: IngestionOptions;
    let service: IngestionService;
    let config: IntakeExecutionOptions;
    let allowed: boolean;
    let permissions: string[];
    let handlers: IntakeHandler[];
    let clock: Date;
    let failCreate: boolean;
    let failAttach: boolean;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'exec-'));
      clock = new Date('2026-10-09T00:00:00Z');
      allowed = true;
      failCreate = false;
      failAttach = false;
      permissions = ['contents.create', 'contents.addAsset'];
      if (dialect === 'postgres') {
        const base = process.env.DATABASE_URL;
        if (!base) throw new Error('PostgreSQL required');
        admin = await getTestDatabase({
          type: 'postgres',
          url: base,
          classes: [],
          includeSystemTables: false,
        });
        dbName = `exec_${randomUUID().replaceAll('-', '')}`;
        await admin.query(`CREATE DATABASE ${dbName}`);
        const url = new URL(base);
        url.pathname = `/${dbName}`;
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
      handlers = referenceHandlers({
        afterCreate: async () => {
          if (failCreate) throw new Error('rollback requested');
        },
        beforeAttach: async () => {
          if (failAttach) throw new Error('attach requested failure');
        },
      });
      config = {
        handlers,
        authorize: async ({ scope }) => ({
          allowed:
            allowed &&
            scope.tenantId === tenant &&
            scope.confidentialScopeId === 'private' &&
            ['owner', 'reviewer'].includes(scope.actorId),
          reviewer: scope.actorId === 'owner' || scope.actorId === 'reviewer',
          principalId: principal,
          permissions,
          mutationBoundary: 'serialized',
          policy: [
            {
              version: 'app1',
              handlers: handlers.map((h) => h.id),
              operations: handlers.map((h) =>
                'model' in h.operation
                  ? `${h.operation.model}:${h.operation.action}@${h.operation.version}`
                  : h.operation.playbookKey,
              ),
              reviewers: ['owner', 'reviewer'],
              access: ['private'],
              requireReview: true,
              maxAttempts: 3,
              maxSteps: 10,
              maxBytes: 65536,
              approvalMs: 100000,
              leaseMs: 100,
            },
            { version: 'tenant1' },
            { version: 'source1' },
          ],
        }),
        assertTarget: assertReferenceTarget,
      };
      options = {
        db,
        assets: await createAssetRuntime({ db, storage: join(root, 'assets') }),
        scope: {
          tenantId: tenant,
          actorId: 'owner',
          confidentialScopeId: 'private',
        },
        authorize: async ({ scope }) =>
          allowed &&
          scope.tenantId === tenant &&
          scope.confidentialScopeId === 'private' &&
          ['owner', 'reviewer'].includes(scope.actorId),
        jobTarget: { objectType: workerType, method: 'process' },
        purgeDerived: async () => {},
        now: () => clock,
        execution: config,
      };
      hostOptions = options;
      service = new IngestionService(options);
      await service.assertReady();
    });
    afterEach(async () => {
      await peer?.close?.();
      await db?.close?.();
      if (admin) {
        // Ordinary roles cannot terminate transient background workers. Close
        // our connections, then wait for a normal drop without elevated grants.
        try {
          await dropExecutionDatabase(admin, dbName);
        } finally {
          await admin.close?.();
          admin = undefined;
        }
      }
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function ready() {
      const input: ReceiveInput = {
        sourceId: 'trusted',
        sourceVersion: '1',
        deliveryKey: randomUUID(),
        deliveredAt: clock,
        parts: [
          {
            partId: 'document',
            mediaType: 'text/plain',
            bytes: Buffer.from('trusted retained text'),
          },
        ],
        capturedCeiling: {
          execution: {
            principalId: principal,
            permissions: ['contents.create', 'contents.addAsset'],
            handlers: handlers.map((h) => h.id),
            operations: handlers.map((h) =>
              'model' in h.operation
                ? `${h.operation.model}:${h.operation.action}@${h.operation.version}`
                : h.operation.playbookKey,
            ),
          },
        },
        retention: {
          version: '1',
          expiresAt: new Date(clock.getTime() + 1000000),
          replayUntil: new Date(clock.getTime() + 2000000),
          acceptAfter: new Date(clock.getTime() - 1000),
        },
        limits: {
          maxBytes: 4096,
          maxParts: 2,
          maxAttempts: 3,
          leaseMs: 1000,
          maxOutputBytes: 4096,
        },
      };
      const receipt = await service.receive(input);
      if (!('itemId' in receipt)) throw new Error(JSON.stringify(receipt));
      const analysis = await service.analyze(
        receipt.itemId,
        { version: '1' },
        'analysis',
      );
      const lease = await service.claimAnalysis(
        receipt.itemId,
        analysis.revision,
        'worker',
      );
      if (!lease) throw new Error('lease');
      await service.completeAnalysis(lease, {
        status: 'completed',
        provider: 'fixture',
        model: 'fixture',
        version: '1',
        output: { title: 'Draft', body: 'Text' },
        usage: {},
      });
      return {
        itemId: receipt.itemId,
        attemptId: lease.attemptId,
        evidenceId: (await service.getEvidence(receipt.itemId))[0].id,
      };
    }
    async function proposal() {
      const input = await ready();
      const actionId = await service.createAction(input.itemId, 'draft', {
        explicit: true,
      });
      const review = await service.previewProposal({
        ...input,
        actionId,
        expectedRevision: 0,
        requestId: 'preview',
        handlerId: CREATE,
        handlerVersion: '1',
        args: { title: 'Draft', body: 'Body' },
      });
      return { ...input, review, actionId };
    }
    async function approve(review: ProposalReview, use = service) {
      return use.submitDecision({
        actionId: review.actionId,
        expectedRevision: review.revision,
        expectedReviewVersion: review.reviewVersion,
        bindingHash: review.bindingHash,
        requestId: `approve:${review.revision}`,
        decision: 'approve',
      });
    }
    async function configurePlan(
      onStepFailure: 'abort' | 'continue' = 'abort',
    ) {
      const key = `ingestion-test-${randomUUID()}`;
      definePlaybook({
        key,
        title: 'Draft with evidence',
        description: 'Create a draft, then attach retained evidence.',
        onStepFailure,
        steps: [
          { kind: 'operation', model: CONTENT, action: 'create' },
          { kind: 'operation', model: CONTENT, action: 'addAsset' },
        ],
      });
      const resolved = await resolvePlaybook(key, {
        db,
        tenantId: tenant,
        plane: 'server',
        classifier: () => ({
          effect: 'write',
          idempotent: false,
          openWorld: false,
        }),
      });
      if (!resolved.ok) throw new Error('playbook');
      // Classification is part of the pinned definition, matching each actual operation.
      const actual = await resolvePlaybook(key, {
        db,
        tenantId: tenant,
        plane: 'server',
        classifier: ({ action }) =>
          (
            handlers.find(
              (entry) =>
                'execution' in entry && entry.operation.action === action,
            ) as OperationHandler
          ).capability,
      });
      if (!actual.ok) throw new Error('playbook');
      const plan: PlanHandler = {
        id: '@test/ingestion:draft-with-evidence',
        version: '1',
        description: 'Draft and evidence',
        operation: {
          playbookKey: key,
          definitionHash: intakeBindingDigest(actual.plan),
        },
        argsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'evidenceId'],
          properties: {
            title: { type: 'string', maxLength: 200 },
            evidenceId: { type: 'string', maxLength: 64 },
          },
        },
        resultSchema: { type: 'object', additionalProperties: false },
        resultModels: {},
        validate: async () => ({ ok: true }),
        preview: async (args) => ({
          normalizedArgs: args,
          display: args,
          targetPreconditions: [],
        }),
        expand: async (args): ReturnType<PlanHandler['expand']> => [
          {
            stepIndex: 0,
            handlerId: CREATE,
            handlerVersion: '1',
            args: { title: args.title, body: 'Body' },
            resultBindings: {},
          },
          {
            stepIndex: 1,
            handlerId: ATTACH,
            handlerVersion: '1',
            args: { evidenceId: args.evidenceId },
            resultBindings: {
              contentId: {
                stepIndex: 0,
                resultField: 'contentId',
                expectedModel: DOCUMENT,
              },
            },
          },
        ],
      };
      handlers.push(plan);
      return plan;
    }
    it('commits one real draft under concurrent repeated apply and stable replay', async () => {
      const handler = handlers[0] as OperationHandler;
      const preview = handler.preview;
      handler.preview = async (args, context) => {
        const result = await preview(args, context);
        return {
          ...result,
          display: {
            ...result.display,
            dependencies: 'application detail',
            plan: 'application plan detail',
          },
        };
      };
      const { review, actionId } = await proposal();
      expect(review.display.preview).toMatchObject({
        dependencies: 'application detail',
        plan: 'application plan detail',
      });
      await approve(review);
      const other = new IngestionService({
        ...options,
        db: peer,
        scope: { ...options.scope, actorId: 'reviewer' },
      });
      const outcomes = await Promise.all([
        service.applyAction(actionId),
        other.applyAction(actionId),
      ]);
      expect(outcomes.map((outcome) => outcome.state)).toEqual([
        'succeeded',
        'succeeded',
      ]);
      expect(outcomes[0].result).toEqual(outcomes[1].result);
      const rows = await db.query(
        'SELECT tenant_id,status,context FROM contents',
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        tenant_id: tenant,
        status: 'draft',
        context: 'private',
      });
      expect(await service.applyAction(actionId)).toEqual(outcomes[0]);
    });
    it('rolls domain writes back with execution failure and retries only the same action', async () => {
      const { review, actionId } = await proposal();
      await approve(review);
      failCreate = true;
      expect((await service.applyAction(actionId)).state).toBe('failed');
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
      expect(
        (
          await db.query(
            "SELECT id FROM intake_executions WHERE state='succeeded'",
          )
        ).rows,
      ).toHaveLength(0);
      failCreate = false;
      expect((await service.applyAction(actionId)).state).toBe('succeeded');
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(1);
    });
    it('rejects forged/stale decisions and admits only one concurrent reviewer', async () => {
      const { review } = await proposal();
      await expect(
        service.submitDecision({
          actionId: review.actionId,
          expectedRevision: 99,
          expectedReviewVersion: review.reviewVersion,
          bindingHash: review.bindingHash,
          requestId: 'forged',
          decision: 'approve',
        }),
      ).rejects.toThrow();
      const other = new IngestionService({
        ...options,
        db: peer,
        scope: { ...options.scope, actorId: 'reviewer' },
      });
      const decisions = await Promise.allSettled([
        approve(review),
        other.submitDecision({
          actionId: review.actionId,
          expectedRevision: review.revision,
          expectedReviewVersion: review.reviewVersion,
          bindingHash: review.bindingHash,
          requestId: 'reject',
          decision: 'reject',
        }),
      ]);
      expect(
        decisions.filter((decision) => decision.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        (await db.query('SELECT id FROM intake_review_decisions')).rows,
      ).toHaveLength(1);
    });
    it('reauthorizes against current grants, captured ceiling and active confidential scope', async () => {
      const { review, actionId } = await proposal();
      await approve(review);
      permissions = [];
      await expect(service.applyAction(actionId)).rejects.toThrow();
      permissions = ['contents.create'];
      for (const scope of [
        { ...options.scope, actorId: 'attacker' },
        { ...options.scope, confidentialScopeId: 'other' },
        { ...options.scope, tenantId: '22222222-2222-4222-8222-222222222222' },
      ]) {
        await expect(
          new IngestionService({ ...options, scope }).applyAction(actionId),
        ).rejects.toThrow();
      }
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
      expect((await service.applyAction(actionId)).state).toBe('succeeded');
    });
    it('corrects into a new review revision and keeps reject/defer non-executable', async () => {
      const { review, actionId } = await proposal();
      const edited = await service.submitDecision({
        actionId,
        expectedRevision: review.revision,
        expectedReviewVersion: review.reviewVersion,
        bindingHash: review.bindingHash,
        requestId: 'edit',
        decision: 'correct',
        correctedArgs: { title: 'Corrected', body: 'Body' },
      });
      expect(edited.revision).toBe(2);
      await expect(approve(review)).rejects.toThrow();
      await expect(service.applyAction(actionId)).rejects.toThrow('Approval');
      await service.submitDecision({
        actionId,
        expectedRevision: edited.revision,
        expectedReviewVersion: edited.reviewVersion,
        bindingHash: edited.bindingHash,
        requestId: 'defer',
        decision: 'defer',
      });
      await expect(service.applyAction(actionId)).rejects.toThrow('Approval');
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
    });
    it('binds exact arguments, handler versions, target freshness and approval expiry', async () => {
      const { review, actionId } = await proposal();
      await approve(review);
      const handler = handlers[0] as OperationHandler;
      handler.version = '2';
      await expect(service.applyAction(actionId)).rejects.toThrow();
      handler.version = '1';
      clock = new Date(clock.getTime() + 100001);
      await expect(service.applyAction(actionId)).rejects.toThrow('Approval');
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
    });
    it('keeps completed action identity beyond retention and job cleanup', async () => {
      const { review, actionId, itemId } = await proposal();
      await approve(review);
      const result = await service.applyAction(actionId);
      await db.query('DELETE FROM _smrt_jobs');
      await service.expire(itemId);
      const replay = await service.applyAction(actionId);
      expect(replay).toMatchObject({
        state: 'succeeded',
        actionId,
        resultDigest: result.resultDigest,
        tombstone: true,
      });
      expect(replay.result).toBeUndefined();
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(1);
      await expect(
        service.publishProposal({
          itemId,
          actionId,
          attemptId: '',
          expectedRevision: 1,
          binding: {},
        }),
      ).rejects.toThrow();
    });
    it('executes a real dependent draft and attachment plan without repeating successful steps', async () => {
      const handler = await configurePlan();
      const input = await ready();
      const plan = await service.previewPlan({
        ...input,
        planKey: 'draft-plan',
        expectedRevision: 0,
        requestId: 'plan1',
        handlerId: handler.id,
        handlerVersion: handler.version,
        args: { title: 'Plan draft', evidenceId: input.evidenceId },
      });
      expect(plan.steps).toHaveLength(2);
      for (const step of plan.steps) await approve(step);
      failAttach = true;
      expect(
        (await service.applyPlan(plan.id)).map((step) => step.state),
      ).toEqual(['succeeded', 'failed']);
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(1);
      expect(
        (await db.query('SELECT id FROM content_assets')).rows,
      ).toHaveLength(0);
      failAttach = false;
      expect(
        (await service.applyPlan(plan.id)).map((step) => step.state),
      ).toEqual(['succeeded', 'succeeded']);
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(1);
      expect(
        (await db.query('SELECT id FROM content_assets')).rows,
      ).toHaveLength(1);
      expect(
        (await service.applyPlan(plan.id)).map((step) => step.state),
      ).toEqual(['succeeded', 'succeeded']);
      expect(
        (await db.query('SELECT id FROM content_assets')).rows,
      ).toHaveLength(1);
    });
    it('rejects changed symbolic predecessor target and rechecks grants at each plan step', async () => {
      const handler = await configurePlan();
      const input = await ready();
      const plan = await service.previewPlan({
        ...input,
        planKey: 'plan',
        expectedRevision: 0,
        requestId: 'plan',
        handlerId: handler.id,
        handlerVersion: handler.version,
        args: { title: 'Target', evidenceId: input.evidenceId },
      });
      for (const step of plan.steps) await approve(step);
      const first = await service.applyAction(plan.steps[0].actionId);
      const content = await (await Contents.create({ db })).get({
        id: String(first.result!.contentId),
      });
      if (!content) throw new Error('content');
      content.title = 'Materially changed';
      await content.save();
      await expect(service.applyAction(plan.steps[1].actionId)).rejects.toThrow(
        'Target changed',
      );
      permissions = ['contents.create'];
      await expect(
        service.applyAction(plan.steps[1].actionId),
      ).rejects.toThrow();
      expect(
        (await db.query('SELECT id FROM content_assets')).rows,
      ).toHaveLength(0);
    });
    it('records unknown external outcomes and reconciles before any repeat send', async () => {
      let sends = 0;
      let known = false;
      const external: OperationHandler = {
        ...(handlers[0] as OperationHandler),
        id: '@test/ingestion:external',
        resultModels: {},
        resultSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['receipt'],
          properties: { receipt: { type: 'string', maxLength: 64 } },
        },
        capability: { effect: 'write', idempotent: false, openWorld: true },
        execution: {
          kind: 'external',
          submit: async (_args, _context, key) => {
            sends++;
            known = true;
            throw new Error(`sent:${key}`);
          },
          reconcile: async () =>
            known
              ? { kind: 'succeeded', result: { receipt: 'provider-result' } }
              : { kind: 'unknown' },
        },
      };
      handlers.push(external);
      const input = await ready();
      const actionId = await service.createAction(input.itemId, 'external', {});
      const review = await service.previewProposal({
        ...input,
        actionId,
        expectedRevision: 0,
        requestId: 'external',
        handlerId: external.id,
        handlerVersion: '1',
        args: { title: 'Send', body: 'Body' },
      });
      await approve(review);
      expect((await service.applyAction(actionId)).state).toBe(
        'outcome_unknown',
      );
      expect(
        (await new IngestionService(options).applyAction(actionId)).state,
      ).toBe('outcome_unknown');
      expect(sends).toBe(1);
      expect(await service.reconcileAction(actionId)).toMatchObject({
        state: 'succeeded',
        result: { receipt: 'provider-result' },
      });
      expect((await service.applyAction(actionId)).state).toBe('succeeded');
      expect(sends).toBe(1);
    });
    it('requires evaluated layered opt-in and rechecks machine eligibility before mutation', async () => {
      const authorize = config.authorize;
      let eligible = true;
      config.authorize = async (input) => {
        const access = await authorize(input);
        return {
          ...access,
          policy: access.policy.map((layer) => ({
            ...layer,
            requireReview: false,
            automation: { handlers: [CREATE], evaluationVersion: 'eval1' },
          })) as typeof access.policy,
        };
      };
      config.evaluateAutomatic = async () => ({
        eligible,
        evaluationVersion: 'eval1',
        certainty: 1,
      });
      const { actionId } = await proposal();
      await expect(service.applyAction(actionId)).rejects.toThrow('Approval');
      await service.authorizeAutomatic(actionId);
      const decision = (
        await db.query('SELECT data FROM intake_review_decisions')
      ).rows[0].data;
      expect(
        typeof decision === 'string' ? JSON.parse(decision) : decision,
      ).toMatchObject({ kind: 'machine', evaluator: 'eval1' });
      eligible = false;
      await expect(service.applyAction(actionId)).rejects.toThrow(
        'eligibility',
      );
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
      eligible = true;
      expect((await service.applyAction(actionId)).state).toBe('succeeded');
    });
    it('fails closed for unknown handlers, malformed arguments/results and rejected decisions', async () => {
      const input = await ready();
      const actionId = await service.createAction(input.itemId, 'invalid', {});
      const preview = {
        ...input,
        actionId,
        expectedRevision: 0,
        requestId: 'invalid',
        handlerId: CREATE,
        handlerVersion: '1',
        args: { title: 'Draft', body: 'Body' },
      };
      await expect(
        service.previewProposal({ ...preview, handlerId: '@unknown:handler' }),
      ).rejects.toThrow();
      await expect(
        service.previewProposal({
          ...preview,
          args: { ...preview.args, arbitraryTool: 'delete' },
        }),
      ).rejects.toThrow('payload');
      expect(
        (await db.query('SELECT id FROM intake_proposals')).rows,
      ).toHaveLength(0);
      const review = await service.previewProposal(preview);
      await service.submitDecision({
        actionId,
        expectedRevision: review.revision,
        expectedReviewVersion: review.reviewVersion,
        bindingHash: review.bindingHash,
        requestId: 'reject',
        decision: 'reject',
      });
      await expect(service.applyAction(actionId)).rejects.toThrow('Approval');
      const other = await proposal();
      await approve(other.review);
      const handler = handlers[0] as OperationHandler;
      if (handler.execution.kind !== 'database') throw new Error('fixture');
      const apply = handler.execution.apply;
      handler.execution.apply = async (args, context) => {
        await apply(args, context);
        return { arbitrary: 'invalid result' };
      };
      expect((await service.applyAction(other.actionId)).state).toBe('failed');
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
    });
    it('rechecks successful result visibility and refuses changed or cross-item dependencies', async () => {
      const first = await proposal();
      await approve(first.review);
      const result = await service.applyAction(first.actionId);
      const contents = await Contents.create({ db });
      const content = await contents.get({
        id: String(result.result!.contentId),
      });
      if (!content) throw new Error('content');
      content.context = 'other';
      await content.save();
      await expect(service.applyAction(first.actionId)).rejects.toThrow();
      const second = await ready();
      const actionId = await service.createAction(second.itemId, 'attach', {});
      await expect(
        service.previewProposal({
          ...second,
          actionId,
          expectedRevision: 0,
          requestId: 'cross-item',
          handlerId: ATTACH,
          handlerVersion: '1',
          args: { evidenceId: second.evidenceId },
          dependencies: {
            contentId: {
              actionId: first.actionId,
              proposalRevision: 1,
              resultField: 'contentId',
              expectedModel: DOCUMENT,
            },
          },
        }),
      ).rejects.toThrow('dependency');
      expect(
        (await db.query('SELECT id FROM content_assets')).rows,
      ).toHaveLength(0);
    });
    it('re-expands plans into fresh reviews and preserves completed step identity', async () => {
      const handler = await configurePlan();
      const input = await ready();
      const request = {
        ...input,
        planKey: 'reexpand',
        expectedRevision: 0,
        requestId: 'plan1',
        handlerId: handler.id,
        handlerVersion: '1',
        args: { title: 'Pinned', evidenceId: input.evidenceId },
      };
      const first = await service.previewPlan(request);
      for (const step of first.steps) await approve(step);
      await service.applyAction(first.steps[0].actionId);
      const second = await service.previewPlan({
        ...request,
        expectedRevision: 1,
        requestId: 'plan2',
      });
      expect(second.steps[0]).toMatchObject({
        actionId: first.steps[0].actionId,
        revision: 1,
        state: 'succeeded',
      });
      expect(second.steps[1].revision).toBe(2);
      await expect(service.applyPlan(first.id)).rejects.toThrow();
      await expect(
        service.applyAction(second.steps[1].actionId),
      ).rejects.toThrow('Approval');
      await approve(second.steps[1]);
      expect(
        (await service.applyPlan(second.id)).map((step) => step.state),
      ).toEqual(['succeeded', 'succeeded']);
      await expect(
        service.previewPlan({
          ...request,
          expectedRevision: 2,
          requestId: 'changed',
          args: { ...request.args, title: 'Changed' },
        }),
      ).rejects.toThrow('immutable');
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(1);
      expect(
        (await db.query('SELECT id FROM content_assets')).rows,
      ).toHaveLength(1);
    });
    it('blocks cancelled pending execution and records an already issued external success', async () => {
      const pending = await proposal();
      await approve(pending.review);
      await service.cancel(pending.itemId);
      await expect(service.applyAction(pending.actionId)).rejects.toThrow();
      let sends = 0;
      const external: OperationHandler = {
        ...(handlers[0] as OperationHandler),
        id: '@test/ingestion:cancel-external',
        resultModels: {},
        resultSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['receipt'],
          properties: { receipt: { type: 'string' } },
        },
        capability: { effect: 'write', idempotent: false, openWorld: true },
        execution: {
          kind: 'external',
          submit: async (_args, context) => {
            sends++;
            await service.cancel(context.itemId);
            return { receipt: 'issued' };
          },
          reconcile: async () => ({ kind: 'unknown' }),
        },
      };
      handlers.push(external);
      const input = await ready();
      const actionId = await service.createAction(
        input.itemId,
        'external-cancel',
        {},
      );
      const review = await service.previewProposal({
        ...input,
        actionId,
        expectedRevision: 0,
        requestId: 'external-cancel',
        handlerId: external.id,
        handlerVersion: '1',
        args: { title: 'Send', body: 'Body' },
      });
      await approve(review);
      expect(await service.applyAction(actionId)).toMatchObject({
        state: 'succeeded',
        result: { receipt: 'issued' },
      });
      expect((await service.applyAction(actionId)).state).toBe('succeeded');
      expect(sends).toBe(1);
    });
    it('recovers process death after external acceptance without resending', async () => {
      const providerReceipt = join(root, 'provider-receipt.json');
      let sends = 0;
      const external: OperationHandler = {
        ...(handlers[0] as OperationHandler),
        id: '@test/ingestion:crash-external',
        resultModels: {},
        resultSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['receipt'],
          properties: { receipt: { type: 'string', maxLength: 64 } },
        },
        capability: { effect: 'write', idempotent: false, openWorld: true },
        preview: async (args) => ({
          display: args,
          normalizedArgs: args,
          targetPreconditions: [],
        }),
        execution: {
          kind: 'external',
          submit: async () => {
            sends++;
            throw new Error('Must not resend');
          },
          reconcile: async (_context, key) => {
            const stored = JSON.parse(await readFile(providerReceipt, 'utf8'));
            expect(stored.key).toBe(key);
            return { kind: 'succeeded', result: { receipt: stored.receipt } };
          },
        },
      };
      handlers.push(external);
      const input = await ready();
      const actionId = await service.createAction(input.itemId, 'crash', {});
      const review = await service.previewProposal({
        ...input,
        actionId,
        expectedRevision: 0,
        requestId: 'crash',
        handlerId: external.id,
        handlerVersion: '1',
        args: { title: 'Send', body: 'Body' },
      });
      await approve(review);
      const access = await config.authorize({
        db,
        scope: options.scope,
        itemId: input.itemId,
        capturedCeiling: {
          principalId: principal,
          permissions,
          handlers: [external.id],
          operations: [],
        },
        operation: 'execute',
        handlerId: external.id,
      });
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../scripts/crash-execution.mjs', import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            INGESTION_EXECUTION_CRASH_DB: db.url,
            INGESTION_EXECUTION_CRASH_CONFIG: JSON.stringify({
              dialect,
              storage: join(root, 'assets'),
              scope: options.scope,
              jobTarget: options.jobTarget,
              now: clock.toISOString(),
              actionId,
              handler: external,
              access,
              providerReceipt,
            }),
          },
          timeout: 30000,
          encoding: 'utf8',
        },
      );
      expect(child.signal, child.stderr).toBe('SIGKILL');
      expect(
        (
          await db.query(
            'SELECT state FROM intake_actions WHERE id=?',
            actionId,
          )
        ).rows[0].state,
      ).toBe('executing');
      clock = new Date(clock.getTime() + 101);
      expect(
        (await new IngestionService(options).applyAction(actionId)).state,
      ).toBe('outcome_unknown');
      expect(await service.reconcileAction(actionId)).toMatchObject({
        state: 'succeeded',
        result: { receipt: 'provider-accepted' },
      });
      expect(sends).toBe(0);
      expect(
        (
          await db.query(
            'SELECT id FROM intake_executions WHERE action_id=?',
            actionId,
          )
        ).rows,
      ).toHaveLength(1);
    });
    it('requires conclusive reconciliation before retrying the same external key', async () => {
      const keys: string[] = [];
      let outcome: 'unknown' | 'not_applied' | 'malformed' = 'unknown';
      const external: OperationHandler = {
        ...(handlers[0] as OperationHandler),
        id: '@test/ingestion:reconcile',
        resultModels: {},
        resultSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['receipt'],
          properties: { receipt: { type: 'string' } },
        },
        capability: { effect: 'write', idempotent: false, openWorld: true },
        execution: {
          kind: 'external',
          submit: async (_args, _context, key) => {
            keys.push(key);
            if (keys.length === 1) throw new Error('network unavailable');
            return { receipt: 'accepted' };
          },
          reconcile: async () => ({ kind: outcome }) as { kind: 'unknown' },
        },
      };
      handlers.push(external);
      const input = await ready();
      const actionId = await service.createAction(
        input.itemId,
        'reconcile',
        {},
      );
      const review = await service.previewProposal({
        ...input,
        actionId,
        expectedRevision: 0,
        requestId: 'reconcile',
        handlerId: external.id,
        handlerVersion: '1',
        args: { title: 'Send', body: 'Body' },
      });
      await approve(review);
      expect((await service.applyAction(actionId)).state).toBe(
        'outcome_unknown',
      );
      expect((await service.reconcileAction(actionId)).state).toBe(
        'outcome_unknown',
      );
      outcome = 'malformed';
      await expect(service.reconcileAction(actionId)).rejects.toThrow(
        'Invalid reconciliation',
      );
      expect((await service.applyAction(actionId)).state).toBe(
        'outcome_unknown',
      );
      expect(keys).toHaveLength(1);
      outcome = 'not_applied';
      expect((await service.reconcileAction(actionId)).state).toBe('failed');
      expect((await service.applyAction(actionId)).state).toBe('succeeded');
      expect(keys).toEqual([actionId, actionId]);
    });
    for (const failurePolicy of ['abort', 'continue'] as const)
      it(`honors pinned ${failurePolicy} policy for independent later steps`, async () => {
        const key = `two-drafts-${randomUUID()}`;
        const create = handlers[0] as OperationHandler;
        if (create.execution.kind !== 'database') throw new Error('fixture');
        const apply = create.execution.apply;
        create.execution.apply = async (args, context) => {
          const result = await apply(args, context);
          if (args.title === 'Fail') throw new Error('first step rollback');
          return result;
        };
        definePlaybook({
          key,
          title: 'Two drafts',
          description: 'Independent approved drafts',
          onStepFailure: failurePolicy,
          steps: [
            { kind: 'operation', model: CONTENT, action: 'create' },
            { kind: 'operation', model: CONTENT, action: 'create' },
          ],
        });
        const resolved = await resolvePlaybook(key, {
          db,
          tenantId: tenant,
          plane: 'server',
          classifier: () => create.capability,
        });
        if (!resolved.ok) throw new Error('playbook');
        const plan: PlanHandler = {
          id: '@test/ingestion:two-drafts',
          version: '1',
          description: 'Two drafts',
          operation: {
            playbookKey: key,
            definitionHash: intakeBindingDigest(resolved.plan),
          },
          argsSchema: { type: 'object', additionalProperties: false },
          resultSchema: { type: 'object', additionalProperties: false },
          resultModels: {},
          validate: async () => ({ ok: true }),
          preview: async (args) => ({
            display: args,
            normalizedArgs: args,
            targetPreconditions: [],
          }),
          expand: async () => [
            {
              stepIndex: 0,
              handlerId: CREATE,
              handlerVersion: '1',
              args: { title: 'Fail', body: 'Body' },
              resultBindings: {},
            },
            {
              stepIndex: 1,
              handlerId: CREATE,
              handlerVersion: '1',
              args: { title: 'Succeed', body: 'Body' },
              resultBindings: {},
            },
          ],
        };
        handlers.push(plan);
        const input = await ready();
        const review = await service.previewPlan({
          ...input,
          planKey: 'two',
          expectedRevision: 0,
          requestId: 'two',
          handlerId: plan.id,
          handlerVersion: '1',
          args: {},
        });
        for (const step of review.steps) await approve(step);
        expect(
          (await service.applyPlan(review.id)).map((step) => step.state),
        ).toEqual(
          failurePolicy === 'abort' ? ['failed'] : ['failed', 'succeeded'],
        );
        expect((await db.query('SELECT title FROM contents')).rows).toEqual(
          failurePolicy === 'abort' ? [] : [{ title: 'Succeed' }],
        );
      });
    it('atomically consumes the final database attempt under competing failing workers', async () => {
      const authorize = config.authorize;
      config.authorize = async (input) => {
        const current = await authorize(input);
        current.policy[0] = { ...current.policy[0], maxAttempts: 1 };
        return current;
      };
      const { review, actionId } = await proposal();
      await approve(review);
      failCreate = true;
      const other = new IngestionService({ ...options, db: peer });
      const outcomes = await Promise.allSettled([
        service.applyAction(actionId),
        other.applyAction(actionId),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === 'rejected'),
      ).toHaveLength(1);
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
      expect(
        (
          await db.query(
            'SELECT attempt_number,state FROM intake_executions WHERE action_id=?',
            actionId,
          )
        ).rows.map((row) => ({
          attempt: Number(row.attempt_number),
          state: row.state,
        })),
      ).toEqual([{ attempt: 1, state: 'failed' }]);
    });
    it('rejects changed stored arguments and grants beyond the captured ceiling', async () => {
      const first = await proposal();
      await approve(first.review);
      const stored = (
        await db.query(
          'SELECT data FROM intake_proposals WHERE id=?',
          first.review.proposalId,
        )
      ).rows[0].data;
      const data =
        typeof stored === 'string'
          ? JSON.parse(stored)
          : structuredClone(stored);
      data.binding.args.title = 'Unreviewed mutation';
      await db.query(
        'UPDATE intake_proposals SET data=? WHERE id=?',
        JSON.stringify(data),
        first.review.proposalId,
      );
      await expect(service.applyAction(first.actionId)).rejects.toThrow(
        'integrity',
      );
      const dangerous: OperationHandler = {
        ...(handlers[0] as OperationHandler),
        id: '@test/ingestion:delete',
        operation: { model: CONTENT, action: 'delete', version: '1' },
        capability: {
          effect: 'destructive',
          idempotent: true,
          openWorld: false,
        },
      };
      handlers.push(dangerous);
      permissions = ['contents.create', 'contents.addAsset', 'contents.delete'];
      const input = await ready();
      const actionId = await service.createAction(
        input.itemId,
        'outside-ceiling',
        {},
      );
      const review = await service.previewProposal({
        ...input,
        actionId,
        expectedRevision: 0,
        requestId: 'outside-ceiling',
        handlerId: dangerous.id,
        handlerVersion: '1',
        args: { title: 'Denied', body: 'Body' },
      });
      await approve(review);
      await expect(service.applyAction(actionId)).rejects.toThrow();
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
    });
    it('rejects forward/cyclic plan bindings and changed playbook definitions before effects', async () => {
      const handler = await configurePlan();
      const input = await ready();
      const request = {
        ...input,
        planKey: 'invalid-plan',
        expectedRevision: 0,
        requestId: 'invalid',
        handlerId: handler.id,
        handlerVersion: '1',
        args: { title: 'Draft', evidenceId: input.evidenceId },
      };
      const expand = handler.expand;
      handler.expand = async (args, definition) => {
        const steps = await expand(args, definition);
        steps[1].resultBindings.contentId.stepIndex = 1;
        return steps;
      };
      await expect(service.previewPlan(request)).rejects.toThrow('dependency');
      expect((await db.query('SELECT id FROM intake_plans')).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('SELECT id FROM intake_proposals')).rows,
      ).toHaveLength(0);
      handler.expand = expand;
      const plan = await service.previewPlan(request);
      for (const step of plan.steps) await approve(step);
      const preview = handler.preview;
      handler.preview = async (args) => ({
        display: { changed: true },
        normalizedArgs: args,
        targetPreconditions: [],
      });
      expect(
        (await service.applyPlan(plan.id)).map((step) => step.state),
      ).toEqual(['failed']);
      handler.preview = preview;
      handler.operation.definitionHash = 'changed';
      expect(
        (await service.applyPlan(plan.id)).map((step) => step.state),
      ).toEqual(['failed']);
      expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(0);
    });
    if (dialect === 'postgres')
      it('fails cleanup on a live connection deadline and leaves its database intact', async () => {
        await expect(
          dropExecutionDatabase(admin!, dbName, 0),
        ).rejects.toMatchObject({ cause: { code: '55006' } });
        expect((await db.query('SELECT 1 AS alive')).rows).toEqual([
          { alive: 1 },
        ]);
        // afterEach closes both ordinary-role sessions and must then drop it.
      });
    for (const forged of [false, true])
      it(`restarts durable review without an occupied worker; forged answer=${forged}`, async () => {
        const { review, actionId } = await proposal();
        const ctor = ObjectRegistry.getClass(workerType)!.constructor;
        const target = new ctor({ db });
        await target.initialize();
        await target.save();
        const store = await McpTaskStore.create(db, {
          ownerId: 'owner',
          tenantId: tenant,
          requireAuthorization: true,
        });
        const binding = {
          recordId: actionId,
          revision: `${review.revision}:${review.bindingHash}`,
          inputKey: 'review',
        };
        const task = await store.createTask({
          objectType: workerType,
          objectId: String(target.id),
          method: 'review',
          invocationArgs: [{ actionId }],
          continuation: binding,
          tenantId: tenant,
        });
        const start = async () => {
          const runner = createTaskRunner({
            queues: ['mcp-tasks'],
            pollInterval: 10,
            concurrency: 1,
            retention: false,
            authorizeMcpTask: async (authority) => {
              if (
                !allowed ||
                authority.ownerId !== 'owner' ||
                authority.tenantId !== tenant ||
                authority.continuation?.recordId !== actionId ||
                authority.continuation.revision !== binding.revision
              )
                return false;
              const current = await service.getAction(actionId);
              return (
                current.bindingHash === review.bindingHash &&
                current.revision === review.revision
              );
            },
          });
          await runner.initialize(db);
          await runner.start();
          return runner;
        };
        const first = await start();
        try {
          await vi.waitFor(
            async () =>
              expect(await store.getContinuation(task.taskId)).not.toBeNull(),
            { timeout: 10000, interval: 20 },
          );
          const job = (
            await db.query(
              'SELECT status,worker_id FROM _smrt_jobs WHERE task_id=?',
              task.taskId,
            )
          ).rows[0];
          expect(job).toMatchObject({ status: 'pending', worker_id: null });
          expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(
            0,
          );
        } finally {
          await first.stop();
        }
        const restored = await McpTaskStore.create(db, {
          ownerId: 'owner',
          tenantId: tenant,
          requireAuthorization: true,
        });
        const wrong = await McpTaskStore.create(db, {
          ownerId: 'attacker',
          tenantId: tenant,
          requireAuthorization: true,
        });
        await expect(
          wrong.updateTask(task.taskId, { review: 'approve' }),
        ).rejects.toThrow();
        if (!forged) await approve(review);
        await restored.updateTask(task.taskId, {
          review: { decision: 'approve', forgedActor: 'owner' },
        });
        const second = await start();
        try {
          await vi.waitFor(
            async () =>
              expect((await restored.getTask(task.taskId)).status).toBe(
                'completed',
              ),
            { timeout: 10000, interval: 20 },
          );
          expect((await db.query('SELECT id FROM contents')).rows).toHaveLength(
            forged ? 0 : 1,
          );
          expect(
            (await db.query('SELECT id FROM intake_review_decisions')).rows,
          ).toHaveLength(forged ? 0 : 1);
        } finally {
          await second.stop();
        }
      });
  });
}

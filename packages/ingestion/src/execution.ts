import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { executeAsPrincipal } from '@happyvertical/smrt-agents';
import {
  detectEngine,
  isEmbeddedDatabase,
  ObjectRegistry,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { JobExecutionContext } from '@happyvertical/smrt-jobs';
import { resolvePlaybook } from '@happyvertical/smrt-playbooks';
import type { DatabaseInterface } from '@happyvertical/sql';
import Ajv from 'ajv';
import type {
  ActionResult,
  ExecutionAccessInput,
  ExecutionCeiling,
  HandlerContext,
  IntakeExecutionOptions,
  IntakeHandler,
  IntakeValues,
  OperationHandler,
  PlanReview,
  PreviewPlanInput,
  PreviewProposalInput,
  ProposalReview,
  ResultReference,
  ReviewInput,
} from './execution-contracts.js';
import {
  type DiscoveryGate,
  discoveryTransaction,
  type TransactionRunner,
} from './execution-internal.js';
import { intersect, resolveIntakePolicy } from './policy.js';
import type { ReviewAction, ReviewPage } from './review-dto.js';
import type { IngestionOptions } from './server.js';

export type * from './execution-contracts.js';
export type { IntakePolicy, IntakePolicyLayer } from './policy.js';
export { resolveIntakePolicy } from './policy.js';

class RetentionExpired extends Error {
  constructor(
    readonly itemId: string,
    readonly deadline: number,
  ) {
    super('Intake retention expired');
  }
}
type Row = Record<string, unknown>;
function object(value: unknown): IntakeValues {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid intake binding');
  return parsed as IntakeValues;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`)
      .join(',')}}`;
  throw new Error('Invalid intake binding');
}
export function intakeBindingDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 512)
    throw new Error('Invalid intake identifier');
}
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || !entry)
  )
    throw new Error('Invalid captured authority');
  return value;
}
function time(value: unknown): number {
  return new Date(value as string).getTime();
}
interface Binding {
  handlerId: string;
  handlerVersion: string;
  operation: OperationHandler['operation'];
  capability: OperationHandler['capability'];
  args: IntakeValues;
  display: IntakeValues;
  targetPreconditions: Array<{ model: string; id: string; revision: string }>;
  dependencies: Record<string, ResultReference>;
  evidence: Array<{ id: string; hash: string }>;
  policyVersions: string[];
  plan?: {
    key: string;
    revision: number;
    digest: string;
    display: IntakeValues;
  };
}
interface Bound {
  item: Row;
  action: Row;
  proposal: Row;
  binding: Binding;
  handler: OperationHandler;
}
/** Server-only authoritative review/apply. Construct only from authenticated host options. */
export class IntakeExecutionService {
  private readonly retentionIntents = new AsyncLocalStorage<
    Map<string, number>
  >();
  private readonly db: DatabaseInterface;
  private readonly config: IntakeExecutionOptions;
  private readonly scope;
  private readonly ajv = new Ajv({
    strict: true,
    allErrors: false,
    validateFormats: false,
  });
  constructor(
    private readonly options: IngestionOptions,
    config: IntakeExecutionOptions,
  ) {
    this.db = options.db;
    this.config = config;
    this.scope = Object.freeze({ ...options.scope });
    const engine = detectEngine(
      this.db.url ?? '',
      (this.db as DatabaseInterface & { type?: string }).type,
    );
    if (!['sqlite', 'postgres'].includes(engine) || !this.db.transaction)
      throw new Error('Ingestion execution requires SQLite or PostgreSQL');
    if (
      new Set(
        config.handlers.map((handler) => `${handler.id}@${handler.version}`),
      ).size !== config.handlers.length
    )
      throw new Error('Duplicate intake handler');
  }
  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  private async tx<T>(work: (db: DatabaseInterface) => Promise<T>): Promise<T> {
    return this.withRetention(() =>
      withEmbeddedWriteTransaction(this.db, isEmbeddedDatabase(this.db), work),
    );
  }
  private async withRetention<T>(work: () => Promise<T>): Promise<T> {
    // Authorized privacy ceilings survive business rollback, including savepoints.
    // Keep intents local to this async transaction; concurrent calls cannot share them.
    const intents = new Map<string, number>();
    try {
      return await this.retentionIntents.run(intents, work);
    } catch (error) {
      // Early expired apply has already authorized/locked the item, but has
      // not entered policy access. Its redaction must survive rollback too.
      if (error instanceof RetentionExpired)
        intents.set(
          error.itemId,
          Math.min(intents.get(error.itemId) ?? Infinity, error.deadline),
        );
      if (intents.size)
        await withEmbeddedWriteTransaction(
          this.db,
          isEmbeddedDatabase(this.db),
          async (db) => {
            for (const [itemId, deadline] of intents) {
              await this.restoreRetention(db, itemId, deadline);
            }
          },
        );
      throw error;
    }
  }
  private async restoreRetention(
    db: DatabaseInterface,
    itemId: string,
    deadline: number,
  ): Promise<Row> {
    // This intent was already authorized. Do not acquire another content-read
    // grant after rollback: a revoked actor must not undo a privacy maximum.
    const expiry = new Date(deadline).toISOString();
    const result = await db.query(
      'UPDATE intake_items SET expires_at=CASE WHEN expires_at>? THEN ? ELSE expires_at END WHERE id=? AND tenant_id=? AND confidential_scope_id=? RETURNING id,expires_at,visibility',
      expiry,
      expiry,
      itemId,
      this.scope.tenantId,
      this.scope.confidentialScopeId,
    );
    const item = result.rows[0];
    if (!item) throw new Error('Intake unavailable');
    if (!this.retained(item)) await this.redactExecution(db, item);
    return item;
  }
  private async redactExecution(
    db: DatabaseInterface,
    item: Row,
  ): Promise<void> {
    for (const table of [
      'intake_actions',
      'intake_proposals',
      'intake_review_decisions',
      'intake_executions',
      'intake_plans',
      'intake_feedback',
    ])
      await db.query(
        `UPDATE ${table} SET data='{}' WHERE item_id=? AND tenant_id=? AND confidential_scope_id=?`,
        item.id,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
      );
  }
  private async narrowRetention(
    db: DatabaseInterface,
    item: Row,
    deadline: number,
  ): Promise<void> {
    const current = await this.item(db, String(item.id), true, true);
    const effective = Math.min(time(current.expires_at), deadline);
    if (!Number.isFinite(effective))
      throw new Error('Invalid retention deadline');
    if (effective < time(current.expires_at))
      await db.query(
        'UPDATE intake_items SET expires_at=? WHERE id=? AND tenant_id=? AND confidential_scope_id=?',
        new Date(effective).toISOString(),
        item.id,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
      );
    item.expires_at = new Date(effective).toISOString();
    item.visibility = current.visibility;
    if (!this.retained(item)) await this.redactExecution(db, item);
  }

  private async rows(
    db: DatabaseInterface,
    table: string,
    where = '',
    params: unknown[] = [],
  ): Promise<Row[]> {
    return (
      await db.query(
        `SELECT * FROM ${table} WHERE tenant_id=? AND confidential_scope_id=?${where ? ` AND ${where}` : ''}`,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        ...params,
      )
    ).rows as Row[];
  }
  private async insert(
    db: DatabaseInterface,
    table: string,
    values: Row,
  ): Promise<Row> {
    const row = {
      id: randomUUID(),
      slug: randomUUID(),
      context: '',
      created_at: this.now().toISOString(),
      updated_at: this.now().toISOString(),
      tenant_id: this.scope.tenantId,
      confidential_scope_id: this.scope.confidentialScopeId,
      ...values,
    };
    return (
      await db.query(
        `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
          row,
        )
          .map(() => '?')
          .join(',')}) RETURNING *`,
        ...Object.values(row),
      )
    ).rows[0] as Row;
  }
  private async item(
    db: DatabaseInterface,
    itemId: string,
    lock = false,
    expired = false,
  ): Promise<Row> {
    if (lock)
      await db.query(
        'UPDATE intake_items SET analysis_revision=analysis_revision WHERE id=? AND tenant_id=? AND confidential_scope_id=?',
        itemId,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
      );
    const [item] = await this.rows(db, 'intake_items', 'id=?', [itemId]);
    if (
      !item ||
      !(await this.options.authorize({
        scope: this.scope,
        operation: 'read',
        capturedCeiling: object(object(item.data).capturedCeiling),
        db,
      }))
    )
      throw new Error('Intake unavailable');
    if (
      !expired &&
      (item.visibility !== 'active' ||
        time(item.expires_at) <= this.now().getTime() ||
        item.cancelled)
    )
      throw new Error('Intake unavailable');
    return item;
  }
  private ceiling(item: Row): ExecutionCeiling {
    const value = object(object(object(item.data).capturedCeiling).execution);
    id(value.principalId);
    return {
      principalId: value.principalId,
      permissions: strings(value.permissions),
      handlers: strings(value.handlers),
      operations: strings(value.operations),
    };
  }
  private handler(handlerId: string, version: string): IntakeHandler {
    const found = this.config.handlers.find(
      (h) => h.id === handlerId && h.version === version,
    );
    if (!found || !handlerId.includes(':') || !version)
      throw new Error('Handler unavailable');
    return found;
  }
  private operation(handler: IntakeHandler): OperationHandler {
    if (!('execution' in handler) || !('model' in handler.operation))
      throw new Error('Single operation required');
    const registered = ObjectRegistry.getClassByQualifiedName(
      handler.operation.model,
    );
    if (
      !registered ||
      !registered.collection ||
      (!['create', 'get', 'list', 'update', 'delete'].includes(
        handler.operation.action,
      ) &&
        !registered.methods.has(handler.operation.action)) ||
      !handler.operation.version ||
      !['read', 'write', 'destructive'].includes(
        handler.capability.effect ?? '',
      ) ||
      typeof handler.capability.idempotent !== 'boolean' ||
      typeof handler.capability.openWorld !== 'boolean'
    )
      throw new Error('Undeclared capability');
    return handler;
  }
  private validate(
    schema: IntakeValues,
    value: IntakeValues,
    limit: number,
  ): void {
    if (
      Buffer.byteLength(canonical(value)) > limit ||
      schema.type !== 'object' ||
      schema.additionalProperties !== false
    )
      throw new Error('Invalid handler payload');
    if (!this.ajv.compile(schema)(value))
      throw new Error('Invalid handler payload');
  }
  private async access(
    db: DatabaseInterface,
    item: Row,
    handler: IntakeHandler,
    operation: ExecutionAccessInput['operation'],
  ) {
    const ceiling = this.ceiling(item);
    const current = await this.config.authorize({
      db,
      scope: this.scope,
      itemId: String(item.id),
      capturedCeiling: ceiling,
      operation,
      handlerId: handler.id,
    });
    if (
      !current.allowed ||
      current.mutationBoundary !== 'serialized' ||
      current.principalId !== ceiling.principalId
    )
      throw new Error('Intake unavailable');
    const policy = resolveIntakePolicy(current.policy);
    const operationKey =
      'model' in handler.operation
        ? `${handler.operation.model}:${handler.operation.action}@${handler.operation.version}`
        : handler.operation.playbookKey;
    if (
      !policy.enabled ||
      !policy.handlers.includes(handler.id) ||
      !ceiling.handlers.includes(handler.id) ||
      !policy.operations.includes(operationKey) ||
      !ceiling.operations.includes(operationKey) ||
      !policy.access.includes(this.scope.confidentialScopeId)
    )
      throw new Error('Intake unavailable');
    if (
      operation === 'review' &&
      (!current.reviewer || !policy.reviewers.includes(this.scope.actorId))
    )
      throw new Error('Intake unavailable');
    const deadline = Math.min(
      time(item.expires_at),
      time(item.created_at) + policy.retentionMs,
    );
    const enforce = async (executor: DatabaseInterface) => {
      const intents = this.retentionIntents.getStore();
      const itemId = String(item.id);
      intents?.set(itemId, Math.min(intents.get(itemId) ?? Infinity, deadline));
      await this.narrowRetention(executor, item, deadline);
    };
    if (db === this.db) await this.tx(enforce);
    else await enforce(db);
    if (
      !this.retained(item) &&
      operation !== 'read' &&
      operation !== 'reconcile'
    )
      throw new RetentionExpired(String(item.id), deadline);
    const context: HandlerContext = {
      db,
      scope: this.scope,
      itemId: String(item.id),
      policy,
      assertTarget: async (model, targetId, revision) => {
        await this.config.assertTarget({
          db,
          scope: this.scope,
          itemId: String(item.id),
          model,
          id: targetId,
          ...(revision === undefined ? {} : { revision }),
        });
      },
    };
    return {
      current,
      ceiling,
      policy,
      context,
      permissions: intersect(strings(current.permissions), ceiling.permissions),
    };
  }
  private async principal<T>(
    db: DatabaseInterface,
    item: Row,
    handler: OperationHandler,
    operation: 'execute' | 'reconcile' | 'preview',
    work: (context: HandlerContext) => Promise<T>,
  ): Promise<T> {
    const access = await this.access(db, item, handler, operation);
    const registered = ObjectRegistry.getClassByQualifiedName(
      handler.operation.model,
    )!;
    const tool = `${registered.collection}.${handler.operation.action}`;
    return executeAsPrincipal(
      {
        db,
        principal: {
          runAsUserId: access.ceiling.principalId,
          tenantId: this.scope.tenantId,
          allowedTools: [tool],
        },
        permissions: access.permissions,
        postgresRls: false,
        onBehalfOfUserId: this.scope.actorId,
        action:
          operation === 'preview' ? 'ingestion.discovery' : 'ingestion.execute',
        auditMetadata: { itemId: item.id, handler: handler.id },
        audit: async () => {},
      },
      async (run) => {
        run.assertToolAllowed(tool);
        await run.assertOperation(
          registered.collection!,
          handler.operation.action,
          { db },
        );
        return work({ ...access.context, principal: run });
      },
    );
  }
  /** Current discovery authority. Trusted callbacks use context.db for bounded reads. */
  async withDiscoveryContext<T>(
    itemId: string,
    handlerId: string,
    handlerVersion: string,
    work: (context: HandlerContext) => Promise<T>,
  ): Promise<T> {
    return this.tx((db) =>
      this.discoveryContext(db, itemId, handlerId, handlerVersion, work),
    );
  }
  /** Keep retention restoration outside the supplied foundation transaction. */
  [discoveryTransaction]<T>(
    run: TransactionRunner<T>,
    itemId: string,
    work: (db: DatabaseInterface, authorize: DiscoveryGate) => Promise<T>,
    requireReview = false,
  ): Promise<T> {
    return this.withRetention(() =>
      run(async (db) => {
        const authorize: DiscoveryGate = (
          handlerId,
          handlerVersion,
          callback,
        ) =>
          this.discoveryContext(
            db,
            itemId,
            handlerId,
            handlerVersion,
            (context) =>
              callback(context, (model, id) =>
                this.config.assertTarget({
                  db,
                  scope: this.scope,
                  itemId,
                  model,
                  id,
                }),
              ),
            requireReview,
          );
        const result = await work(db, authorize);
        // A foundation retry must retain the narrowest authorized privacy ceiling.
        for (const [
          retainedItemId,
          deadline,
        ] of this.retentionIntents.getStore() ?? []) {
          const item = await this.restoreRetention(
            db,
            retainedItemId,
            deadline,
          );
          if (!this.retained(item))
            throw new RetentionExpired(retainedItemId, deadline);
        }
        return result;
      }),
    );
  }
  private async discoveryContext<T>(
    db: DatabaseInterface,
    itemId: string,
    handlerId: string,
    handlerVersion: string,
    work: (context: HandlerContext) => Promise<T>,
    requireReview = false,
  ): Promise<T> {
    const review = async () => {
      const item = await this.item(db, itemId, true);
      await this.access(
        db,
        item,
        this.handler(handlerId, handlerVersion),
        'review',
      );
    };
    const authorize = async <R>(
      callback: (context: HandlerContext) => Promise<R>,
    ) => {
      const item = await this.item(db, itemId, true);
      const handler = this.handler(handlerId, handlerVersion);
      if ('execution' in handler)
        return this.principal(
          db,
          item,
          this.operation(handler),
          'preview',
          callback,
        );
      const { context } = await this.access(db, item, handler, 'preview');
      const resolved = await resolvePlaybook(handler.operation.playbookKey, {
        db,
        tenantId: this.scope.tenantId,
        plane: 'server',
        classifier: ({ model, action }) => {
          const found = this.config.handlers.find(
            (entry) =>
              'execution' in entry &&
              entry.operation.model === model &&
              entry.operation.action === action,
          );
          return found && 'execution' in found ? found.capability : undefined;
        },
      });
      if (
        !resolved.ok ||
        intakeBindingDigest(resolved.plan) !==
          handler.operation.definitionHash ||
        resolved.plan.steps.some(
          (step) =>
            step.step.kind !== 'operation' || !step.classificationDeclared,
        )
      )
        throw new Error('Playbook unavailable');
      for (const entry of resolved.plan.steps) {
        const operation = entry.step;
        if (operation.kind !== 'operation')
          throw new Error('Playbook unavailable');
        const found = this.config.handlers.find(
          (candidate) =>
            'execution' in candidate &&
            candidate.operation.model === operation.model &&
            candidate.operation.action === operation.action,
        );
        if (!found) throw new Error('Handler unavailable');
        await this.principal(
          db,
          item,
          this.operation(found),
          'preview',
          async () => {},
        );
      }
      return callback(context);
    };
    if (requireReview) await review();
    const result = await authorize(work);
    // A long database callback may cross retention or a current-grant boundary.
    await authorize(async () => {});
    if (requireReview) await review();
    return result;
  }

  private async bound(
    db: DatabaseInterface,
    actionId: string,
    lock = false,
    expired = false,
  ): Promise<Bound> {
    const [found] = await this.rows(db, 'intake_actions', 'id=?', [actionId]);
    if (!found) throw new Error('Intake unavailable');
    const item = await this.item(db, String(found.item_id), lock, expired);
    const [action] = await this.rows(db, 'intake_actions', 'id=?', [actionId]);
    const [proposal] = await this.rows(
      db,
      'intake_proposals',
      'action_id=? AND revision=?',
      [actionId, action.proposal_revision],
    );
    if (!proposal) throw new Error('Proposal unavailable');
    const binding = object(object(proposal.data).binding) as unknown as Binding;
    const handler = this.operation(
      this.handler(binding.handlerId, binding.handlerVersion),
    );
    if (
      canonical(handler.operation) !== canonical(binding.operation) ||
      canonical(handler.capability) !== canonical(binding.capability)
    )
      throw new Error('Handler version drift');
    return { item, action, proposal, binding, handler };
  }
  private review(bound: Bound): ProposalReview {
    return {
      actionId: String(bound.action.id),
      proposalId: String(bound.proposal.id),
      revision: Number(bound.proposal.revision),
      reviewVersion: Number(bound.action.review_version),
      bindingHash: String(bound.proposal.binding_hash),
      display: bound.binding.plan
        ? { step: bound.binding.display, plan: bound.binding.plan.display }
        : bound.binding.display,
      state: String(bound.action.state),
    };
  }
  async getAction(actionId: string): Promise<ProposalReview> {
    return this.tx(async (db) => {
      const [action] = await this.rows(db, 'intake_actions', 'id=?', [
        actionId,
      ]);
      if (!action) throw new Error('Intake unavailable');
      const item = await this.item(db, String(action.item_id), true, true);
      const expiredReview = async (): Promise<ProposalReview> => {
        await this.redactExecution(db, item);
        const [proposal] = await this.rows(
          db,
          'intake_proposals',
          'action_id=? AND revision=?',
          [actionId, action.proposal_revision],
        );
        if (!proposal) throw new Error('Proposal unavailable');
        return {
          actionId,
          proposalId: String(proposal.id),
          revision: Number(proposal.revision),
          reviewVersion: Number(action.review_version),
          bindingHash: String(proposal.binding_hash),
          display: {},
          state: 'expired',
        };
      };
      if (!this.retained(item)) return expiredReview();
      const bound = await this.bound(db, actionId);
      await this.access(db, bound.item, bound.handler, 'read');
      if (!this.retained(bound.item)) return expiredReview();
      return this.review(bound);
    });
  }
  /** Bounded reload discovery. The cursor is an opaque action ID, never authority. */
  async listReviews(
    itemId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<ReviewPage> {
    const limit = input.limit ?? 20;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (input.cursor !== undefined && !/^[0-9a-f-]{36}$/i.test(input.cursor))
    )
      throw new Error('Invalid review page');
    return this.tx(async (db) => {
      const item = await this.item(db, itemId, true, true);
      const rows = (
        await db.query(
          `SELECT * FROM intake_actions WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?${input.cursor ? ' AND id>?' : ''} ORDER BY id LIMIT ?`,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          ...(input.cursor ? [input.cursor] : []),
          limit + 1,
        )
      ).rows;
      const actions: ReviewAction[] = [];
      let generationStale = false;
      for (const action of rows.slice(0, limit)) {
        const [proposal] = await this.rows(
          db,
          'intake_proposals',
          'action_id=? AND revision=?',
          [action.id, action.proposal_revision],
        );
        if (!proposal) {
          actions.push({
            review: {
              actionId: String(action.id),
              proposalId: '',
              revision: Number(action.proposal_revision),
              reviewVersion: Number(action.review_version),
              bindingHash: '',
              display: {},
              state: this.retained(item) ? 'proposed' : 'expired',
            },
          });
          continue;
        }
        const tombstone = (state: string): ReviewAction => ({
          review: {
            actionId: String(action.id),
            proposalId: String(proposal.id),
            revision: Number(proposal.revision),
            reviewVersion: Number(action.review_version),
            bindingHash: String(proposal.binding_hash),
            display: {},
            state,
          },
        });
        if (!this.retained(item)) {
          actions.push(tombstone('expired'));
          continue;
        }
        const bound = await this.bound(db, String(action.id));
        await this.access(db, bound.item, bound.handler, 'read');
        item.expires_at = bound.item.expires_at;
        if (!this.retained(bound.item)) {
          actions.push(tombstone('expired'));
          continue;
        }
        let stale = false;
        let recoveryAttemptId: string | undefined;
        const authorizeTargets = async (
          targets: Array<{ model: string; id: string; revision: string }>,
        ) => {
          for (const target of targets) {
            // Read authority is current. Historical execution preconditions are
            // freshness fences, not a reason to hide an authorized result/page.
            const current = await this.config.assertTarget({
              db,
              scope: this.scope,
              itemId,
              model: target.model,
              id: target.id,
            });
            if (current.revision !== target.revision) {
              generationStale = true;
              if (bound.action.state !== 'succeeded') stale = true;
            }
          }
        };
        await authorizeTargets(bound.binding.targetPreconditions);
        if (!this.retained(bound.item)) {
          actions.push(tombstone('expired'));
          continue;
        }
        if (bound.action.state !== 'succeeded') {
          const [analysis] = await this.rows(db, 'intake_analyses', 'id=?', [
            proposal.analysis_id,
          ]);
          if (
            !analysis ||
            Number(analysis.revision) !== Number(item.analysis_revision)
          )
            stale = true;
          else {
            await this.verifyEvidence(db, bound);
            const [attempt] = await this.rows(
              db,
              'intake_analysis_attempts',
              'id=? AND analysis_id=?',
              [proposal.analysis_attempt_id, analysis.id],
            );
            if (
              attempt &&
              ['completed', 'partial'].includes(String(attempt.state)) &&
              String(analysis.current_attempt_id) === String(attempt.id)
            )
              recoveryAttemptId = String(attempt.id);
          }
        }
        const entry: ReviewAction = {
          review: this.review(bound),
          args: structuredClone(bound.binding.args),
          handlerId: bound.handler.id,
          handlerVersion: bound.handler.version,
          attemptId: String(proposal.analysis_attempt_id),
          dependencies: structuredClone(bound.binding.dependencies),
        };
        if (action.state === 'succeeded')
          entry.result = await this.successful(db, action, item);
        if (bound.binding.plan) {
          const [plan] = await this.rows(
            db,
            'intake_plans',
            bound.action.state === 'succeeded'
              ? 'item_id=? AND plan_key=? AND revision=?'
              : 'item_id=? AND plan_key=? ORDER BY revision DESC LIMIT 1',
            bound.action.state === 'succeeded'
              ? [itemId, bound.binding.plan.key, bound.binding.plan.revision]
              : [itemId, bound.binding.plan.key],
          );
          if (!plan) throw new Error('Plan unavailable');
          if (
            bound.action.state !== 'succeeded' &&
            Number(plan.revision) !== bound.binding.plan.revision
          )
            stale = true;
          const planData = object(plan.data);
          const parent = this.handler(
            String(planData.handlerId),
            String(planData.handlerVersion),
          );
          const parentPreview = object(planData.preview);
          await this.discoveryContext(
            db,
            itemId,
            parent.id,
            parent.version,
            async () => {
              await authorizeTargets(
                parentPreview.targetPreconditions as Array<{
                  model: string;
                  id: string;
                  revision: string;
                }>,
              );
            },
          );
          const steps = planData.steps as Array<{ actionId: string }>;
          entry.plan = {
            id: String(plan.id),
            key: String(plan.plan_key),
            revision: Number(plan.revision),
            stepIndex: steps.findIndex((step) => step.actionId === action.id),
            args: object(planData.args),
            handlerId: parent.id,
            handlerVersion: parent.version,
            attemptId: String(proposal.analysis_attempt_id),
          };
        }
        await this.access(db, bound.item, bound.handler, 'read');
        actions.push(
          !this.retained(bound.item)
            ? tombstone('expired')
            : stale
              ? {
                  ...tombstone('stale'),
                  ...(recoveryAttemptId
                    ? {
                        attemptId: recoveryAttemptId,
                        handlerId: bound.handler.id,
                        handlerVersion: bound.handler.version,
                      }
                    : {}),
                  ...(entry.plan
                    ? {
                        stalePlan: {
                          id: entry.plan.id,
                          key: entry.plan.key,
                          revision: entry.plan.revision,
                          handlerId: entry.plan.handlerId,
                          handlerVersion: entry.plan.handlerVersion,
                        },
                      }
                    : {}),
                }
              : entry,
        );
      }
      // Later callbacks can cross the shared deadline; publish no earlier payload then.
      const current = await this.item(db, itemId, false, true);
      if (!this.retained(current)) {
        await this.redactExecution(db, current);
        for (let index = 0; index < actions.length; index++)
          actions[index] = {
            review: { ...actions[index].review, display: {}, state: 'expired' },
          };
      }
      return {
        actions,
        ...(generationStale ? { generationStale: true } : {}),
        ...(rows.length > limit
          ? { nextCursor: String(rows[limit - 1].id) }
          : {}),
      };
    });
  }
  private async buildBinding(
    db: DatabaseInterface,
    item: Row,
    input: PreviewProposalInput,
  ): Promise<Binding> {
    const handler = this.operation(
      this.handler(input.handlerId, input.handlerVersion),
    );
    const { policy, context } = await this.access(db, item, handler, 'preview');
    const dependencies = input.dependencies ?? {};
    const concrete = { ...input.args };
    for (const [field, ref] of Object.entries(dependencies)) {
      if (
        Object.hasOwn(input.args, field) ||
        !field ||
        ref.actionId === input.actionId
      )
        throw new Error('Invalid dependency');
      const [predecessor] = await this.rows(
        db,
        'intake_actions',
        'id=? AND item_id=?',
        [ref.actionId, input.itemId],
      );
      const [proposal] = await this.rows(
        db,
        'intake_proposals',
        'action_id=? AND revision=? AND item_id=?',
        [ref.actionId, ref.proposalRevision, input.itemId],
      );
      if (
        !predecessor ||
        !proposal ||
        Number(predecessor.proposal_revision) !== ref.proposalRevision ||
        ['rejected', 'deferred'].includes(String(predecessor.state))
      )
        throw new Error('Invalid dependency');
      const binding = object(
        object(proposal.data).binding,
      ) as unknown as Binding;
      const prior = this.operation(
        this.handler(binding.handlerId, binding.handlerVersion),
      );
      if (prior.resultModels[ref.resultField] !== ref.expectedModel)
        throw new Error('Invalid dependency');
      const pending = [ref.actionId];
      const visited = new Set<string>();
      while (pending.length) {
        const dependencyId = pending.pop()!;
        if (dependencyId === input.actionId || visited.size > policy.maxSteps)
          throw new Error('Dependency cycle');
        if (visited.has(dependencyId)) continue;
        visited.add(dependencyId);
        const [dependencyAction] = await this.rows(
          db,
          'intake_actions',
          'id=? AND item_id=?',
          [dependencyId, input.itemId],
        );
        const [dependencyProposal] = dependencyAction
          ? await this.rows(
              db,
              'intake_proposals',
              'action_id=? AND revision=?',
              [dependencyId, dependencyAction.proposal_revision],
            )
          : [];
        if (!dependencyProposal) throw new Error('Dependency unavailable');
        for (const predecessor of Object.values(
          object(object(object(dependencyProposal.data).binding).dependencies),
        ))
          pending.push(String(object(predecessor).actionId));
      }
      // A symbolic ID validates against the handler schema, but is never executed.
      concrete[field] = `00000000-0000-4000-8000-000000000000`;
    }
    this.validate(handler.argsSchema, concrete, policy.maxBytes);
    if (!(await handler.validate(input.args, context)).ok)
      throw new Error('Invalid handler arguments');
    const preview = await handler.preview(input.args, context);
    if (canonical(preview.normalizedArgs) !== canonical(input.args))
      throw new Error(
        'Preview arguments must be normalized before publication',
      );
    for (const target of preview.targetPreconditions)
      await context.assertTarget(target.model, target.id, target.revision);
    const [attempt] = await this.rows(
      db,
      'intake_analysis_attempts',
      'id=? AND item_id=?',
      [input.attemptId, input.itemId],
    );
    if (
      !attempt ||
      !['completed', 'partial'].includes(String(attempt.state)) ||
      !attempt.output_digest
    )
      throw new Error('Invalid proposal evidence');
    const [analysis] = await this.rows(
      db,
      'intake_analyses',
      'id=? AND item_id=?',
      [attempt.analysis_id, input.itemId],
    );
    if (
      !analysis ||
      Number(analysis.revision) !== Number(item.analysis_revision)
    )
      throw new Error('Stale analysis');
    const inputs = object(analysis.data).inputs;
    if (!Array.isArray(inputs)) throw new Error('Invalid evidence');
    const evidence = [];
    for (const entry of inputs) {
      const frozen = object(entry);
      const [row] = await this.rows(
        db,
        'intake_evidence',
        "id=? AND item_id=? AND state='durable'",
        [frozen.id, input.itemId],
      );
      if (!row || row.content_hash !== frozen.hash)
        throw new Error('Evidence unavailable');
      evidence.push({ id: String(row.id), hash: String(row.content_hash) });
    }
    const display = {
      preview: preview.display,
      dependencies: await Promise.all(
        Object.entries(dependencies).map(async ([field, ref]) => {
          const [proposal] = await this.rows(
            db,
            'intake_proposals',
            'action_id=? AND revision=?',
            [ref.actionId, ref.proposalRevision],
          );
          return {
            field,
            ...ref,
            predecessorPreview: object(object(proposal.data).binding).display,
          };
        }),
      ),
    };
    const binding = {
      handlerId: handler.id,
      handlerVersion: handler.version,
      operation: handler.operation,
      capability: handler.capability,
      args: input.args,
      display,
      targetPreconditions: preview.targetPreconditions,
      dependencies,
      evidence,
      policyVersions: policy.versions,
    };
    if (Buffer.byteLength(canonical(binding)) > policy.maxBytes)
      throw new Error('Proposal budget exceeded');
    return binding;
  }
  private async publish(
    db: DatabaseInterface,
    item: Row,
    input: PreviewProposalInput,
    binding: Binding,
  ): Promise<ProposalReview> {
    if (!this.retained(item))
      throw new RetentionExpired(String(item.id), time(item.expires_at));
    id(input.requestId);
    const [action] = await this.rows(
      db,
      'intake_actions',
      'id=? AND item_id=?',
      [input.actionId, input.itemId],
    );
    if (!action) throw new Error('Intake unavailable');
    const prior = await this.rows(db, 'intake_proposals', 'action_id=?', [
      input.actionId,
    ]);
    const requestHash = intakeBindingDigest(input);
    const replay = prior.find(
      (row) => object(row.data).requestId === input.requestId,
    );
    if (replay) {
      if (object(replay.data).requestHash !== requestHash)
        throw new Error('Proposal request conflict');
      return {
        actionId: input.actionId,
        proposalId: String(replay.id),
        revision: Number(replay.revision),
        reviewVersion: Number(object(replay.data).reviewVersion),
        bindingHash: String(replay.binding_hash),
        display: object(object(replay.data).binding).display as IntakeValues,
        state: String(action.state),
      };
    }
    if (
      Number(action.proposal_revision) !== input.expectedRevision ||
      ['succeeded', 'executing', 'outcome_unknown'].includes(
        String(action.state),
      )
    )
      throw new Error('Proposal conflict');
    const [attempt] = await this.rows(
      db,
      'intake_analysis_attempts',
      'id=? AND item_id=?',
      [input.attemptId, input.itemId],
    );
    const [analysis] = await this.rows(db, 'intake_analyses', 'id=?', [
      attempt.analysis_id,
    ]);
    const bindingHash = intakeBindingDigest({
      binding,
      attemptId: attempt.id,
      attemptDigest: attempt.output_digest,
      inputDigest: analysis.input_digest,
    });
    const revision = input.expectedRevision + 1;
    const reviewVersion = Number(action.review_version) + 1;
    const proposal = await this.insert(db, 'intake_proposals', {
      item_id: item.id,
      action_id: action.id,
      analysis_id: analysis.id,
      analysis_attempt_id: attempt.id,
      revision,
      binding_hash: bindingHash,
      data: canonical({
        binding,
        attemptDigest: attempt.output_digest,
        requestId: input.requestId,
        requestHash,
        reviewVersion,
      }),
    });
    await db.query(
      "UPDATE intake_actions SET proposal_revision=?,review_version=?,state='waiting_review' WHERE id=? AND tenant_id=? AND confidential_scope_id=?",
      revision,
      reviewVersion,
      action.id,
      this.scope.tenantId,
      this.scope.confidentialScopeId,
    );
    return {
      actionId: String(action.id),
      proposalId: String(proposal.id),
      revision,
      reviewVersion,
      bindingHash,
      display: binding.display,
      state: 'waiting_review',
    };
  }
  async previewProposal(input: PreviewProposalInput): Promise<ProposalReview> {
    // Snapshot client arguments before awaiting authority/preview callbacks.
    const frozen = JSON.parse(canonical(input)) as PreviewProposalInput;
    return this.tx(async (db) => {
      const item = await this.item(db, frozen.itemId, true);
      const binding = await this.buildBinding(db, item, frozen);
      return this.publish(db, item, frozen, binding);
    });
  }
  async submitDecision(input: ReviewInput): Promise<ProposalReview> {
    const frozen = JSON.parse(canonical(input)) as ReviewInput;
    id(frozen.requestId);
    if (
      !['approve', 'reject', 'defer', 'correct'].includes(frozen.decision) ||
      (frozen.reason?.length ?? 0) > 2048
    )
      throw new Error('Invalid decision');
    return this.tx(async (db) => {
      const bound = await this.bound(db, frozen.actionId, true);
      const { policy } = await this.access(
        db,
        bound.item,
        bound.handler,
        'review',
      );
      const decisions = await this.rows(
        db,
        'intake_review_decisions',
        'action_id=?',
        [frozen.actionId],
      );
      const requestHash = intakeBindingDigest(frozen);
      const replay = decisions.find(
        (row) => object(row.data).requestId === frozen.requestId,
      );
      if (replay) {
        const data = object(replay.data);
        if (
          data.requestHash !== requestHash ||
          data.reviewer !== this.scope.actorId
        )
          throw new Error('Decision request conflict');
        return this.review(bound);
      }
      if (
        bound.action.state !== 'waiting_review' ||
        Number(bound.proposal.revision) !== frozen.expectedRevision ||
        Number(bound.action.review_version) !== frozen.expectedReviewVersion ||
        bound.proposal.binding_hash !== frozen.bindingHash
      )
        throw new Error('Stale review');
      await this.verifyEvidence(db, bound);
      const expiresAt = new Date(
        Math.min(
          time(bound.item.expires_at),
          this.now().getTime() + policy.approvalMs,
        ),
      ).toISOString();
      await this.insert(db, 'intake_review_decisions', {
        item_id: bound.item.id,
        action_id: bound.action.id,
        proposal_id: bound.proposal.id,
        review_version: frozen.expectedReviewVersion,
        binding_hash: frozen.bindingHash,
        decision: frozen.decision,
        data: canonical({
          reviewer: this.scope.actorId,
          requestId: frozen.requestId,
          requestHash,
          reason: frozen.reason ?? '',
          expiresAt,
          policyVersions: policy.versions,
          decidedAt: this.now().toISOString(),
          kind: 'human',
        }),
      });
      if (frozen.decision === 'correct') {
        if (bound.binding.plan)
          throw new Error('Plan correction requires re-expansion');
        if (!frozen.correctedArgs)
          throw new Error('Correction arguments required');
        const corrected: PreviewProposalInput = {
          itemId: String(bound.item.id),
          actionId: frozen.actionId,
          attemptId: String(bound.proposal.analysis_attempt_id),
          expectedRevision: frozen.expectedRevision,
          requestId: `correction:${frozen.requestId}`,
          handlerId: bound.handler.id,
          handlerVersion: bound.handler.version,
          args: frozen.correctedArgs,
          dependencies: bound.binding.dependencies,
        };
        const binding = await this.buildBinding(db, bound.item, corrected);
        return this.publish(db, bound.item, corrected, binding);
      }
      const state = {
        approve: 'authorized',
        reject: 'rejected',
        defer: 'deferred',
      }[frozen.decision];
      await db.query(
        'UPDATE intake_actions SET state=? WHERE id=? AND tenant_id=? AND confidential_scope_id=?',
        state,
        frozen.actionId,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
      );
      return { ...this.review(bound), state };
    });
  }
  private async verifyEvidence(
    db: DatabaseInterface,
    bound: Bound,
  ): Promise<void> {
    const [analysis] = await this.rows(
      db,
      'intake_analyses',
      'id=? AND item_id=?',
      [bound.proposal.analysis_id, bound.item.id],
    );
    const [attempt] = await this.rows(
      db,
      'intake_analysis_attempts',
      'id=? AND analysis_id=?',
      [bound.proposal.analysis_attempt_id, bound.proposal.analysis_id],
    );
    if (
      !analysis ||
      !attempt ||
      Number(analysis.revision) !== Number(bound.item.analysis_revision) ||
      !['completed', 'partial'].includes(String(attempt.state)) ||
      attempt.output_digest !== object(bound.proposal.data).attemptDigest
    )
      throw new Error('Stale evidence');
    if (
      intakeBindingDigest({
        binding: bound.binding,
        attemptId: attempt.id,
        attemptDigest: attempt.output_digest,
        inputDigest: analysis.input_digest,
      }) !== bound.proposal.binding_hash
    )
      throw new Error('Proposal integrity');
    for (const frozen of bound.binding.evidence) {
      const [evidence] = await this.rows(
        db,
        'intake_evidence',
        "id=? AND item_id=? AND state='durable'",
        [frozen.id, bound.item.id],
      );
      if (!evidence || evidence.content_hash !== frozen.hash)
        throw new Error('Evidence unavailable');
    }
  }
  private async approved(db: DatabaseInterface, bound: Bound): Promise<number> {
    await this.verifyEvidence(db, bound);
    if (bound.binding.plan) {
      const plans = await this.rows(
        db,
        'intake_plans',
        'item_id=? AND plan_key=?',
        [bound.item.id, bound.binding.plan.key],
      );
      const latest = plans.sort(
        (a, b) => Number(b.revision) - Number(a.revision),
      )[0];
      if (
        !latest ||
        latest.digest !== bound.binding.plan.digest ||
        Number(latest.revision) !== bound.binding.plan.revision
      )
        throw new Error('Plan superseded');
      const definition = object(latest.data);
      const steps = definition.steps as Array<{
        actionId: string;
        proposalRevision: number;
      }>;
      const position = steps.findIndex(
        (step) => step.actionId === bound.action.id,
      );
      if (
        position < 0 ||
        steps[position].proposalRevision !== Number(bound.proposal.revision)
      )
        throw new Error('Plan superseded');
      for (const step of steps.slice(0, position)) {
        const [predecessor] = await this.rows(
          db,
          'intake_actions',
          'id=? AND item_id=?',
          [step.actionId, bound.item.id],
        );
        if (
          !predecessor ||
          Number(predecessor.proposal_revision) !== step.proposalRevision ||
          (predecessor.state !== 'succeeded' &&
            !(
              object(definition.definition).onStepFailure === 'continue' &&
              predecessor.state === 'failed'
            ))
        )
          throw new Error('Plan predecessor incomplete or failed');
      }
      const parent = this.handler(
        String(definition.handlerId),
        String(definition.handlerVersion),
      );
      if (!('playbookKey' in parent.operation))
        throw new Error('Plan unavailable');
      const parentAccess = await this.access(db, bound.item, parent, 'execute');
      const planArgs = object(definition.args);
      if (!(await parent.validate(planArgs, parentAccess.context)).ok)
        throw new Error('Plan validation changed');
      const planPreview = await parent.preview(planArgs, parentAccess.context);
      if (canonical(planPreview) !== canonical(definition.preview))
        throw new Error('Plan preview changed');
      for (const target of planPreview.targetPreconditions)
        await parentAccess.context.assertTarget(
          target.model,
          target.id,
          target.revision,
        );
      const resolved = await resolvePlaybook(parent.operation.playbookKey, {
        db,
        tenantId: this.scope.tenantId,
        plane: 'server',
        classifier: ({ model, action }) => {
          const match = this.config.handlers.find(
            (entry) =>
              'execution' in entry &&
              entry.operation.model === model &&
              entry.operation.action === action,
          );
          return match && 'execution' in match ? match.capability : undefined;
        },
      });
      if (
        !resolved.ok ||
        intakeBindingDigest(resolved.plan) !==
          parent.operation.definitionHash ||
        canonical(resolved.plan) !== canonical(definition.definition)
      )
        throw new Error('Playbook changed');
    }
    const regenerated = await this.buildBinding(db, bound.item, {
      itemId: String(bound.item.id),
      actionId: String(bound.action.id),
      attemptId: String(bound.proposal.analysis_attempt_id),
      expectedRevision: Number(bound.proposal.revision) - 1,
      requestId: 'verify',
      handlerId: bound.handler.id,
      handlerVersion: bound.handler.version,
      args: bound.binding.args,
      dependencies: bound.binding.dependencies,
    });
    if (
      canonical({
        ...regenerated,
        ...(bound.binding.plan ? { plan: bound.binding.plan } : {}),
      }) !== canonical(bound.binding)
    )
      throw new Error('Preview changed; review required');
    const { policy } = await this.access(
      db,
      bound.item,
      bound.handler,
      'execute',
    );
    if (canonical(policy.versions) !== canonical(bound.binding.policyVersions))
      throw new Error('Policy changed; review required');
    const [decision] = await this.rows(
      db,
      'intake_review_decisions',
      'action_id=? AND review_version=? AND proposal_id=?',
      [bound.action.id, bound.action.review_version, bound.proposal.id],
    );
    if (
      !decision ||
      decision.decision !== 'approve' ||
      decision.binding_hash !== bound.proposal.binding_hash ||
      time(object(decision.data).expiresAt) <= this.now().getTime()
    )
      throw new Error('Approval required');
    const decisionData = object(decision.data);
    if (decisionData.kind === 'machine') {
      const access = await this.access(
        db,
        bound.item,
        bound.handler,
        'execute',
      );
      const consequential =
        bound.handler.execution.kind === 'external' ||
        bound.handler.capability.effect === 'destructive' ||
        bound.handler.capability.openWorld;
      if (
        !access.policy.automaticHandlers.includes(bound.handler.id) ||
        (consequential && !access.policy.consequentialAutomation) ||
        !this.config.evaluateAutomatic
      )
        throw new Error('Automatic eligibility revoked');
      const evaluated = await this.config.evaluateAutomatic({
        bindingHash: String(bound.proposal.binding_hash),
        handlerId: bound.handler.id,
        context: access.context,
      });
      if (
        !evaluated.eligible ||
        evaluated.evaluationVersion !== decisionData.evaluator ||
        !Number.isFinite(evaluated.certainty) ||
        evaluated.certainty < access.policy.minimumCertainty ||
        evaluated.certainty > 1 ||
        access.current.policy
          .filter((layer, index) => index < 3 || layer.automation !== undefined)
          .some(
            (layer) =>
              layer.automation?.evaluationVersion !==
              evaluated.evaluationVersion,
          )
      )
        throw new Error('Automatic eligibility revoked');
    }
    if (time(object(decision.data).expiresAt) <= this.now().getTime())
      throw new Error('Approval required');
    await this.verifyEvidence(db, bound);
    return Math.min(time(decisionData.expiresAt), time(bound.item.expires_at));
  }
  private async arguments(
    db: DatabaseInterface,
    bound: Bound,
    context: HandlerContext,
  ): Promise<IntakeValues> {
    const args = { ...bound.binding.args };
    for (const target of bound.binding.targetPreconditions)
      await context.assertTarget(target.model, target.id, target.revision);
    for (const [field, reference] of Object.entries(
      bound.binding.dependencies,
    )) {
      const [action] = await this.rows(
        db,
        'intake_actions',
        'id=? AND item_id=?',
        [reference.actionId, bound.item.id],
      );
      const [proposal] = await this.rows(
        db,
        'intake_proposals',
        'action_id=? AND revision=?',
        [reference.actionId, reference.proposalRevision],
      );
      if (
        !action ||
        !proposal ||
        action.state !== 'succeeded' ||
        Number(action.proposal_revision) !== reference.proposalRevision
      )
        throw new Error('Dependency unavailable');
      const [execution] = await this.rows(
        db,
        'intake_executions',
        "action_id=? AND state='succeeded'",
        [action.id],
      );
      if (
        !execution ||
        execution.binding_hash !== proposal.binding_hash ||
        execution.result_digest !== action.result_digest
      )
        throw new Error('Dependency integrity');
      const result = object(object(execution.data).result);
      if (intakeBindingDigest(result) !== execution.result_digest)
        throw new Error('Dependency integrity');
      const handlerBinding = object(object(proposal.data).binding);
      const handler = this.operation(
        this.handler(
          String(handlerBinding.handlerId),
          String(handlerBinding.handlerVersion),
        ),
      );
      if (
        handler.resultModels[reference.resultField] !== reference.expectedModel
      )
        throw new Error('Dependency model changed');
      const targetId = result[reference.resultField];
      id(targetId);
      const targets = object(object(execution.data).resultTargets);
      const pinned = object(targets[reference.resultField]);
      if (
        pinned.id !== targetId ||
        pinned.model !== reference.expectedModel ||
        typeof pinned.revision !== 'string'
      )
        throw new Error('Dependency target integrity');
      await context.assertTarget(
        reference.expectedModel,
        targetId,
        pinned.revision,
      );
      args[field] = targetId;
    }
    this.validate(bound.handler.argsSchema, args, context.policy.maxBytes);
    if (!(await bound.handler.validate(args, context)).ok)
      throw new Error('Invalid handler arguments');
    return args;
  }
  private retained(item: Row): boolean {
    return (
      item.visibility === 'active' &&
      time(item.expires_at) > this.now().getTime()
    );
  }
  private async successful(
    db: DatabaseInterface,
    action: Row,
    item: Row,
  ): Promise<ActionResult> {
    if (!this.retained(item)) {
      await this.redactExecution(db, item);
      return {
        state: 'succeeded',
        actionId: String(action.id),
        resultDigest: String(action.result_digest),
        tombstone: true,
      };
    }
    const [execution] = await this.rows(
      db,
      'intake_executions',
      "action_id=? AND state='succeeded'",
      [action.id],
    );
    if (!execution || execution.result_digest !== action.result_digest)
      throw new Error('Execution integrity');
    const result = object(object(execution.data).result);
    if (intakeBindingDigest(result) !== action.result_digest)
      throw new Error('Execution integrity');
    const bound = await this.bound(db, String(action.id), false, true);
    await this.access(db, item, bound.handler, 'read');
    if (!this.retained(item))
      return {
        state: 'succeeded',
        actionId: String(action.id),
        resultDigest: String(action.result_digest),
        tombstone: true,
      };
    for (const [field, model] of Object.entries(bound.handler.resultModels)) {
      id(result[field]);
      await this.config.assertTarget({
        db,
        scope: this.scope,
        itemId: String(item.id),
        model,
        id: result[field] as string,
      });
    }
    // Target authorization may await across the deadline while we own the lock.
    if (!this.retained(item)) {
      await this.redactExecution(db, item);
      return {
        state: 'succeeded',
        actionId: String(action.id),
        resultDigest: String(action.result_digest),
        tombstone: true,
      };
    }
    return {
      state: 'succeeded',
      actionId: String(action.id),
      result,
      resultDigest: String(action.result_digest),
    };
  }
  private async finish(
    db: DatabaseInterface,
    bound: Bound,
    execution: Row,
    result: IntakeValues,
  ): Promise<ActionResult> {
    await this.access(db, bound.item, bound.handler, 'read');
    const resultDigest = intakeBindingDigest(result);
    const resultTargets: IntakeValues = {};
    for (const [field, model] of Object.entries(
      this.retained(bound.item) ? bound.handler.resultModels : {},
    )) {
      id(result[field]);
      const target = await this.config.assertTarget({
        db,
        scope: this.scope,
        itemId: String(bound.item.id),
        model,
        id: result[field] as string,
      });
      id(target.revision);
      resultTargets[field] = {
        id: result[field],
        model,
        revision: target.revision,
      };
    }
    const tombstone = !this.retained(bound.item);
    if (tombstone) await this.redactExecution(db, bound.item);
    const data = tombstone
      ? {}
      : {
          ...object(execution.data),
          result,
          resultTargets,
          completedAt: this.now().toISOString(),
        };
    const updated = await db.query(
      "UPDATE intake_actions SET state='succeeded',result_digest=? WHERE id=? AND tenant_id=? AND confidential_scope_id=? AND fence=? AND state IN ('executing','outcome_unknown') RETURNING id",
      resultDigest,
      bound.action.id,
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      execution.fence,
    );
    if (!updated.rows.length) throw new Error('Execution fence lost');
    await db.query(
      "UPDATE intake_executions SET state='succeeded',result_digest=?,data=? WHERE id=? AND tenant_id=? AND confidential_scope_id=?",
      resultDigest,
      canonical(data),
      execution.id,
      this.scope.tenantId,
      this.scope.confidentialScopeId,
    );
    return {
      state: 'succeeded',
      actionId: String(bound.action.id),
      ...(tombstone ? { tombstone: true } : { result }),
      resultDigest,
    };
  }
  async applyAction(actionId: string): Promise<ActionResult> {
    id(actionId);
    let reserved:
      | { bound: Bound; execution: Row; args: IntakeValues }
      | undefined;
    const result: ActionResult = await this.tx(async (db) => {
      const [action] = await this.rows(db, 'intake_actions', 'id=?', [
        actionId,
      ]);
      if (!action) throw new Error('Intake unavailable');
      const item = await this.item(db, String(action.item_id), true, true);
      const [current] = await this.rows(db, 'intake_actions', 'id=?', [
        actionId,
      ]);
      if (current.state === 'succeeded')
        return this.successful(db, current, item);
      if (!this.retained(item)) {
        await this.redactExecution(db, item);
        if (current.state === 'outcome_unknown')
          return { state: 'outcome_unknown', actionId, tombstone: true };
        throw new RetentionExpired(String(item.id), time(item.expires_at));
      }
      const bound = await this.bound(db, actionId);
      if (bound.action.state === 'outcome_unknown') {
        await this.access(db, bound.item, bound.handler, 'read');
        return {
          state: 'outcome_unknown',
          actionId,
          ...(!this.retained(bound.item) ? { tombstone: true } : {}),
        };
      }
      if (bound.action.state === 'executing') {
        await this.access(db, bound.item, bound.handler, 'read');
        const [execution] = await this.rows(
          db,
          'intake_executions',
          'action_id=? AND attempt_number=?',
          [actionId, bound.action.execution_attempt],
        );
        if (time(object(execution.data).leaseUntil) > this.now().getTime())
          return { state: 'executing', actionId };
        // External reservation may have crossed the network: reconciliation only.
        await db.query(
          "UPDATE intake_actions SET state='outcome_unknown' WHERE id=? AND tenant_id=? AND confidential_scope_id=?",
          actionId,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
        );
        await db.query(
          "UPDATE intake_executions SET state='outcome_unknown' WHERE id=? AND tenant_id=? AND confidential_scope_id=?",
          execution.id,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
        );
        return { state: 'outcome_unknown', actionId };
      }
      if (!['authorized', 'failed'].includes(String(bound.action.state)))
        throw new Error('Approval required');
      await this.approved(db, bound);
      return this.principal(
        db,
        bound.item,
        bound.handler,
        'execute',
        async (context) => {
          if (
            Number(bound.action.execution_attempt) >= context.policy.maxAttempts
          )
            throw new Error('Execution budget exceeded');
          const args = await this.arguments(db, bound, context);
          const attemptNumber = Number(bound.action.execution_attempt) + 1;
          const fence = Number(bound.action.fence) + 1;
          const execution = await this.insert(db, 'intake_executions', {
            item_id: bound.item.id,
            action_id: actionId,
            attempt_number: attemptNumber,
            fence,
            state: 'claimed',
            binding_hash: bound.proposal.binding_hash,
            result_digest: '',
            idempotency_key: actionId,
            data: canonical({
              leaseUntil: new Date(
                this.now().getTime() + context.policy.leaseMs,
              ).toISOString(),
              principalId: context.principal!.context.userId,
              requestedBy: this.scope.actorId,
              permissions: context.principal!.permissions,
              policyVersions: context.policy.versions,
              proposalRevision: bound.proposal.revision,
              argsDigest: intakeBindingDigest(args),
            }),
          });
          await db.query(
            "UPDATE intake_actions SET state='executing',execution_attempt=?,fence=? WHERE id=? AND tenant_id=? AND confidential_scope_id=?",
            attemptNumber,
            fence,
            actionId,
            this.scope.tenantId,
            this.scope.confidentialScopeId,
          );
          if (bound.handler.execution.kind === 'external') {
            reserved = { bound, execution, args };
            return { state: 'executing', actionId };
          }
          await db.query('SAVEPOINT ingestion_domain_effect');
          try {
            const effect = await bound.handler.execution.apply(args, context);
            this.validate(
              bound.handler.resultSchema,
              effect,
              context.policy.maxBytes,
            );
            for (const [field, model] of Object.entries(
              bound.handler.resultModels,
            )) {
              id(effect[field]);
              await context.assertTarget(model, effect[field] as string);
            }
            const completed = await this.finish(db, bound, execution, effect);
            await db.query('RELEASE SAVEPOINT ingestion_domain_effect');
            return completed;
          } catch {
            // Keep the item lock and reserved budget while undoing all domain
            // writes. A competing worker cannot enter a rollback/accounting gap.
            await db.query('ROLLBACK TO SAVEPOINT ingestion_domain_effect');
            await db.query('RELEASE SAVEPOINT ingestion_domain_effect');
            const deadline = this.retentionIntents
              .getStore()
              ?.get(String(bound.item.id));
            if (deadline !== undefined)
              Object.assign(
                bound.item,
                await this.restoreRetention(
                  db,
                  String(bound.item.id),
                  deadline,
                ),
              );
            if (!this.retained(bound.item))
              await this.redactExecution(db, bound.item);
            await db.query(
              "UPDATE intake_executions SET state='failed',data=? WHERE id=? AND tenant_id=? AND confidential_scope_id=?",
              canonical(
                this.retained(bound.item)
                  ? {
                      ...object(execution.data),
                      error: 'domain_failure',
                      rolledBack: true,
                    }
                  : {},
              ),
              execution.id,
              this.scope.tenantId,
              this.scope.confidentialScopeId,
            );
            await db.query(
              "UPDATE intake_actions SET state='failed' WHERE id=? AND tenant_id=? AND confidential_scope_id=?",
              actionId,
              this.scope.tenantId,
              this.scope.confidentialScopeId,
            );
            return {
              state: 'failed',
              actionId,
              ...(!this.retained(bound.item) ? { tombstone: true } : {}),
            };
          }
        },
      );
    });
    if (!reserved) return result;
    const { bound, execution } = reserved;
    try {
      // Reservation commits before network I/O. Reauthorize and validate the
      // authoritative binding after all asynchronous principal/target callbacks,
      // under the owning lock, then submit without another host callback gap.
      const item = await this.item(this.db, String(bound.item.id));
      const effect = await this.principal(
        this.db,
        item,
        bound.handler,
        'execute',
        async () => {
          const send = await this.tx(async (db) => {
            const fresh = await this.bound(db, actionId, true);
            if (
              fresh.action.state !== 'executing' ||
              Number(fresh.action.fence) !== Number(execution.fence) ||
              fresh.proposal.binding_hash !== execution.binding_hash
            )
              throw new Error('Execution fence lost');
            return this.principal(
              db,
              fresh.item,
              fresh.handler,
              'execute',
              async (context) => {
                const currentArgs = await this.arguments(db, fresh, context);
                if (
                  intakeBindingDigest(currentArgs) !==
                  object(execution.data).argsDigest
                )
                  throw new Error('Execution arguments changed');
                const deadline = await this.approved(db, fresh);
                return { bound: fresh, args: currentArgs, context, deadline };
              },
            );
          });
          if (send.bound.handler.execution.kind !== 'external')
            throw new Error('Handler changed');
          // Commit latency cannot extend the approved execution window.
          if (send.deadline <= this.now().getTime())
            throw new Error('Approval required');
          // Do not expose the completed transaction executor to an external adapter.
          const effect = await send.bound.handler.execution.submit(
            send.args,
            {
              ...send.context,
              db: this.db,
              assertTarget: async (model, targetId, revision) => {
                await this.config.assertTarget({
                  db: this.db,
                  scope: this.scope,
                  itemId: String(send.bound.item.id),
                  model,
                  id: targetId,
                  ...(revision === undefined ? {} : { revision }),
                });
              },
            },
            String(execution.idempotency_key),
          );
          this.validate(
            send.bound.handler.resultSchema,
            effect,
            send.context.policy.maxBytes,
          );
          return effect;
        },
      );
      await this.options.checkpoint?.('external-submitted');
      return await this.tx(async (db) => {
        const item = await this.item(db, String(bound.item.id), true, true);
        return this.finish(db, { ...bound, item }, execution, effect);
      });
    } catch {
      return this.tx(async (db) => {
        const item = await this.item(db, String(bound.item.id), true, true);
        await this.access(db, item, bound.handler, 'read');
        if (!this.retained(item)) await this.redactExecution(db, item);
        await db.query(
          "UPDATE intake_actions SET state='outcome_unknown' WHERE id=? AND tenant_id=? AND confidential_scope_id=? AND fence=? AND state='executing'",
          actionId,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          execution.fence,
        );
        await db.query(
          "UPDATE intake_executions SET state='outcome_unknown' WHERE id=? AND tenant_id=? AND confidential_scope_id=? AND state='claimed'",
          execution.id,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
        );
        return {
          state: 'outcome_unknown',
          actionId,
          ...(!this.retained(item) ? { tombstone: true } : {}),
        };
      });
    }
  }
  async reconcileAction(actionId: string): Promise<ActionResult> {
    const reserved = await this.tx(async (db) => {
      const bound = await this.bound(db, actionId, true, true);
      if (bound.action.state === 'succeeded')
        return { result: await this.successful(db, bound.action, bound.item) };
      if (
        !['outcome_unknown', 'executing'].includes(
          String(bound.action.state),
        ) ||
        bound.handler.execution.kind !== 'external'
      )
        throw new Error('Reconciliation unavailable');
      const [execution] = await this.rows(
        db,
        'intake_executions',
        'action_id=? AND attempt_number=?',
        [actionId, bound.action.execution_attempt],
      );
      if (
        bound.action.state === 'executing' &&
        time(object(execution.data).leaseUntil) > this.now().getTime()
      )
        return { result: { state: 'executing', actionId } as ActionResult };
      await this.access(db, bound.item, bound.handler, 'reconcile');
      return { bound, execution };
    });
    if (reserved.result) return reserved.result;
    const { bound, execution } = reserved;
    const observed = await this.principal(
      this.db,
      bound.item,
      bound.handler,
      'reconcile',
      async (context) => {
        if (bound.handler.execution.kind !== 'external')
          throw new Error('Reconciliation unavailable');
        const outcome = await bound.handler.execution.reconcile(
          context,
          String(execution.idempotency_key),
        );
        if (!['succeeded', 'not_applied', 'unknown'].includes(outcome.kind))
          throw new Error('Invalid reconciliation');
        if (outcome.kind === 'succeeded')
          this.validate(
            bound.handler.resultSchema,
            outcome.result,
            context.policy.maxBytes,
          );
        return outcome;
      },
    );
    return this.tx(async (db) => {
      const item = await this.item(db, String(bound.item.id), true, true);
      const [current] = await this.rows(db, 'intake_actions', 'id=?', [
        actionId,
      ]);
      if (current.state === 'succeeded')
        return this.successful(db, current, item);
      if (Number(current.fence) !== Number(execution.fence))
        throw new Error('Reconciliation fence lost');
      await this.access(db, item, bound.handler, 'reconcile');
      if (observed.kind === 'succeeded')
        return this.finish(db, { ...bound, item }, execution, observed.result);
      const state =
        observed.kind === 'not_applied' ? 'failed' : 'outcome_unknown';
      await db.query(
        'UPDATE intake_actions SET state=? WHERE id=? AND tenant_id=? AND confidential_scope_id=?',
        state,
        actionId,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
      );
      await db.query(
        'UPDATE intake_executions SET state=?,data=? WHERE id=? AND tenant_id=? AND confidential_scope_id=?',
        state,
        canonical(
          !this.retained(item)
            ? {}
            : { ...object(execution.data), reconciliation: observed.kind },
        ),
        execution.id,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
      );
      return {
        state,
        actionId,
        ...(!this.retained(item) ? { tombstone: true } : {}),
      };
    });
  }
  /** Machine authorization is separate provenance, never a fabricated human decision. */
  async authorizeAutomatic(actionId: string): Promise<ProposalReview> {
    return this.tx(async (db) => {
      const bound = await this.bound(db, actionId, true);
      const { current, policy, context } = await this.access(
        db,
        bound.item,
        bound.handler,
        'execute',
      );
      const consequential =
        bound.handler.execution.kind === 'external' ||
        bound.handler.capability.effect === 'destructive' ||
        bound.handler.capability.openWorld;
      if (
        bound.action.state !== 'waiting_review' ||
        !policy.automaticHandlers.includes(bound.handler.id) ||
        (consequential && !policy.consequentialAutomation) ||
        !this.config.evaluateAutomatic
      )
        throw new Error('Automatic execution unavailable');
      const evaluated = await this.config.evaluateAutomatic({
        bindingHash: String(bound.proposal.binding_hash),
        handlerId: bound.handler.id,
        context,
      });
      if (
        !evaluated.eligible ||
        !Number.isFinite(evaluated.certainty) ||
        evaluated.certainty < policy.minimumCertainty ||
        evaluated.certainty > 1 ||
        current.policy
          .filter((layer, index) => index < 3 || layer.automation !== undefined)
          .some(
            (layer) =>
              layer.automation?.evaluationVersion !==
              evaluated.evaluationVersion,
          )
      )
        throw new Error('Automatic execution unavailable');
      await this.verifyEvidence(db, bound);
      if (!this.retained(bound.item))
        throw new RetentionExpired(
          String(bound.item.id),
          time(bound.item.expires_at),
        );
      await this.insert(db, 'intake_review_decisions', {
        item_id: bound.item.id,
        action_id: actionId,
        proposal_id: bound.proposal.id,
        review_version: bound.action.review_version,
        binding_hash: bound.proposal.binding_hash,
        decision: 'approve',
        data: canonical({
          kind: 'machine',
          evaluator: evaluated.evaluationVersion,
          certainty: evaluated.certainty,
          policyVersions: policy.versions,
          expiresAt: new Date(
            Math.min(
              time(bound.item.expires_at),
              this.now().getTime() + policy.approvalMs,
            ),
          ).toISOString(),
        }),
      });
      await db.query(
        "UPDATE intake_actions SET state='authorized' WHERE id=? AND tenant_id=? AND confidential_scope_id=?",
        actionId,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
      );
      return { ...this.review(bound), state: 'authorized' };
    });
  }
  async previewPlan(input: PreviewPlanInput): Promise<PlanReview> {
    const frozen = JSON.parse(canonical(input)) as PreviewPlanInput;
    id(frozen.planKey);
    id(frozen.requestId);
    return this.tx(async (db) => {
      const item = await this.item(db, frozen.itemId, true);
      const handler = this.handler(frozen.handlerId, frozen.handlerVersion);
      if (!('expand' in handler) || !('playbookKey' in handler.operation))
        throw new Error('Playbook handler required');
      const { policy, context } = await this.access(
        db,
        item,
        handler,
        'preview',
      );
      this.validate(handler.argsSchema, frozen.args, policy.maxBytes);
      if (!(await handler.validate(frozen.args, context)).ok)
        throw new Error('Invalid plan arguments');
      const preview = await handler.preview(frozen.args, context);
      if (
        canonical(preview.normalizedArgs) !== canonical(frozen.args) ||
        Buffer.byteLength(canonical(preview)) > policy.maxBytes
      )
        throw new Error('Invalid plan preview');
      for (const target of preview.targetPreconditions)
        await context.assertTarget(target.model, target.id, target.revision);
      const resolved = await resolvePlaybook(handler.operation.playbookKey, {
        db,
        tenantId: this.scope.tenantId,
        plane: 'server',
        classifier: ({ model, action }) => {
          const match = this.config.handlers.find(
            (entry) =>
              'execution' in entry &&
              entry.operation.model === model &&
              entry.operation.action === action,
          );
          return match && 'execution' in match ? match.capability : undefined;
        },
      });
      if (
        !resolved.ok ||
        intakeBindingDigest(resolved.plan) !==
          handler.operation.definitionHash ||
        resolved.plan.steps.some(
          (step) =>
            step.step.kind !== 'operation' || !step.classificationDeclared,
        )
      )
        throw new Error('Playbook unavailable');
      const existing = await this.rows(
        db,
        'intake_plans',
        'item_id=? AND plan_key=?',
        [item.id, frozen.planKey],
      );
      const replay = existing.find(
        (plan) => object(plan.data).requestId === frozen.requestId,
      );
      if (replay) {
        if (object(replay.data).requestHash !== intakeBindingDigest(frozen))
          throw new Error('Plan request conflict');
        const steps = object(replay.data).steps as Array<{ actionId: string }>;
        return {
          id: String(replay.id),
          key: frozen.planKey,
          revision: Number(replay.revision),
          digest: String(replay.digest),
          steps: await Promise.all(
            steps.map(async (step) =>
              this.review(await this.bound(db, step.actionId)),
            ),
          ),
        };
      }
      if (
        Math.max(0, ...existing.map((plan) => Number(plan.revision))) !==
        frozen.expectedRevision
      )
        throw new Error('Plan conflict');
      const expanded = await handler.expand(frozen.args, resolved.plan);
      if (
        !expanded.length ||
        expanded.length !== resolved.plan.steps.length ||
        expanded.length > policy.maxSteps
      )
        throw new Error('Invalid expansion');
      const revision = frozen.expectedRevision + 1;
      const reviews: ProposalReview[] = [];
      const created = new Set<string>();
      for (const [index, step] of expanded.entries()) {
        const operation = resolved.plan.steps[index].step;
        const adapter = this.operation(
          this.handler(step.handlerId, step.handlerVersion),
        );
        if (
          step.stepIndex !== index ||
          operation.kind !== 'operation' ||
          adapter.operation.model !== operation.model ||
          adapter.operation.action !== operation.action
        )
          throw new Error('Invalid expansion operation');
        const actionKey = `plan:${frozen.planKey}:${index}`;
        let [action] = await this.rows(
          db,
          'intake_actions',
          'item_id=? AND action_key=?',
          [item.id, actionKey],
        );
        if (!action)
          action = await this.insert(db, 'intake_actions', {
            item_id: item.id,
            action_key: actionKey,
            state: 'proposed',
            proposal_revision: 0,
            review_version: 0,
            execution_attempt: 0,
            fence: 0,
            result_digest: '',
            data: canonical({ planKey: frozen.planKey, stepIndex: index }),
          });
        const dependencies: Record<string, ResultReference> = {};
        for (const [field, dependency] of Object.entries(step.resultBindings)) {
          if (
            !Number.isSafeInteger(dependency.stepIndex) ||
            dependency.stepIndex < 0 ||
            dependency.stepIndex >= index
          )
            throw new Error('Invalid expansion dependency');
          const earlier = reviews[dependency.stepIndex];
          dependencies[field] = {
            actionId: earlier.actionId,
            proposalRevision: earlier.revision,
            resultField: dependency.resultField,
            expectedModel: dependency.expectedModel,
          };
        }
        if (action.state === 'succeeded') {
          const pinned = await this.bound(db, String(action.id));
          if (
            pinned.handler.id !== step.handlerId ||
            pinned.handler.version !== step.handlerVersion ||
            canonical(pinned.binding.args) !== canonical(step.args) ||
            canonical(pinned.binding.dependencies) !== canonical(dependencies)
          )
            throw new Error('Completed plan step is immutable');
          reviews.push(this.review(pinned));
          continue;
        }
        const proposalInput: PreviewProposalInput = {
          itemId: frozen.itemId,
          attemptId: frozen.attemptId,
          actionId: String(action.id),
          expectedRevision: Number(action.proposal_revision),
          requestId: `plan:${frozen.requestId}:${index}`,
          handlerId: step.handlerId,
          handlerVersion: step.handlerVersion,
          args: step.args,
          dependencies,
        };
        const binding = await this.buildBinding(db, item, proposalInput);
        const review = await this.publish(db, item, proposalInput, binding);
        created.add(review.proposalId);
        reviews.push(review);
      }
      // All intermediate rows are uncommitted: seal every new binding before publication.
      const bindings = await Promise.all(
        reviews.map(async (review) => {
          const [proposal] = await this.rows(db, 'intake_proposals', 'id=?', [
            review.proposalId,
          ]);
          return {
            actionId: review.actionId,
            proposalRevision: review.revision,
            binding: object(proposal.data).binding,
          };
        }),
      );
      const digest = intakeBindingDigest({
        definition: resolved.plan,
        preview,
        handlerId: handler.id,
        handlerVersion: handler.version,
        args: frozen.args,
        revision,
        bindings,
      });
      for (const review of reviews) {
        if (!created.has(review.proposalId)) continue;
        const [proposal] = await this.rows(db, 'intake_proposals', 'id=?', [
          review.proposalId,
        ]);
        const data = object(proposal.data);
        const binding = {
          ...object(data.binding),
          plan: {
            key: frozen.planKey,
            revision,
            digest,
            display: preview.display,
          },
        };
        const [attempt] = await this.rows(
          db,
          'intake_analysis_attempts',
          'id=?',
          [proposal.analysis_attempt_id],
        );
        const [analysis] = await this.rows(db, 'intake_analyses', 'id=?', [
          proposal.analysis_id,
        ]);
        const bindingHash = intakeBindingDigest({
          binding,
          attemptId: attempt.id,
          attemptDigest: attempt.output_digest,
          inputDigest: analysis.input_digest,
        });
        await db.query(
          'UPDATE intake_proposals SET binding_hash=?,data=? WHERE id=? AND tenant_id=? AND confidential_scope_id=?',
          bindingHash,
          canonical({ ...data, binding }),
          proposal.id,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
        );
        review.bindingHash = bindingHash;
        review.display = {
          step: object(object(data.binding).display),
          plan: preview.display,
        };
      }
      const plan = await this.insert(db, 'intake_plans', {
        item_id: item.id,
        plan_key: frozen.planKey,
        revision,
        digest,
        data: canonical({
          requestId: frozen.requestId,
          requestHash: intakeBindingDigest(frozen),
          handlerId: handler.id,
          handlerVersion: handler.version,
          definition: resolved.plan,
          preview,
          args: frozen.args,
          steps: reviews.map((review) => ({
            actionId: review.actionId,
            proposalRevision: review.revision,
          })),
        }),
      });
      return {
        id: String(plan.id),
        key: frozen.planKey,
        revision,
        digest,
        steps: reviews,
      };
    });
  }
  async applyPlan(planId: string): Promise<ActionResult[]> {
    const [plan] = await this.rows(this.db, 'intake_plans', 'id=?', [planId]);
    if (!plan) throw new Error('Plan unavailable');
    const item = await this.item(this.db, String(plan.item_id));
    const data = object(plan.data);
    const handler = this.handler(
      String(data.handlerId),
      String(data.handlerVersion),
    );
    await this.access(this.db, item, handler, 'execute');
    const steps = data.steps as Array<{
      actionId: string;
      proposalRevision: number;
    }>;
    const results: ActionResult[] = [];
    for (const step of steps) {
      const bound = await this.bound(this.db, step.actionId);
      if (
        Number(bound.proposal.revision) !== step.proposalRevision ||
        (bound.action.state !== 'succeeded' &&
          bound.binding.plan?.digest !== plan.digest)
      )
        throw new Error('Plan superseded');
      let result: ActionResult;
      try {
        result = await this.applyAction(step.actionId);
      } catch {
        result = { state: 'failed', actionId: step.actionId };
      }
      results.push(result);
      if (
        result.state !== 'succeeded' &&
        object(data.definition).onStepFailure === 'abort'
      )
        break;
    }
    return results;
  }
}

/** A jobs answer only wakes execution; the ledger's authoritative decision still gates apply. */
export async function continueIntakeReview(
  service: {
    getAction(id: string): Promise<ProposalReview>;
    applyAction(id: string): Promise<ActionResult>;
  },
  actionId: string,
  task: NonNullable<JobExecutionContext['task']>,
): Promise<ActionResult> {
  await task.assertAuthorized();
  const review = await service.getAction(actionId);
  if (review.state === 'waiting_review') {
    await task.requestContinuation(
      {
        recordId: actionId,
        revision: `${review.revision}:${review.bindingHash}`,
        inputKey: 'review',
      },
      {
        actionId,
        proposalRevision: review.revision,
        bindingHash: review.bindingHash,
        instruction: 'Use the authenticated application review service.',
      },
    );
    await task.assertAuthorized();
    const current = await service.getAction(actionId);
    if (current.state === 'waiting_review')
      return { state: 'waiting_review', actionId };
    if (
      current.revision !== review.revision ||
      current.bindingHash !== review.bindingHash
    )
      throw new Error('Review continuation superseded');
  }
  await task.assertAuthorized();
  return service.applyAction(actionId);
}

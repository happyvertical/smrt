import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  intakeBindingDigest as digest,
  IntakeExecutionService,
} from './execution.js';
import type { FeedbackConfiguration } from './feedback-contracts.js';
import type {
  AdoptRuleInput,
  FeedbackBinding,
  FeedbackExample,
  FeedbackReceipt,
  FeedbackReferences,
  FeedbackSelection,
  ObserveFeedbackInput,
  ReadRuleInput,
  RecordFeedbackInput,
  RoutingRule,
  RuleAdoption,
  RuleSuggestion,
  SuggestRuleInput,
} from './feedback-dto.js';
import {
  type FeedbackActionContext,
  feedbackActionTransaction,
  feedbackDiscoveryContext,
} from './feedback-internal.js';
import type { GenerationOutput } from './proposal-dto.js';
import type { IngestionOptions } from './server.js';

type Row = Record<string, unknown>;
function object(value: unknown): Row {
  const result = typeof value === 'string' ? JSON.parse(value) : value;
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Feedback unavailable');
  return result as Row;
}
function text(value: unknown, max = 512): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid feedback');
}
function resultData(data: Row): Row {
  return {
    status: data.status,
    provider: data.provider,
    model: data.model,
    version: data.version,
    output: data.output,
    usage: data.usage,
    ...(Object.hasOwn(data, 'error') ? { error: data.error } : {}),
    ...(Object.hasOwn(data, 'confidence')
      ? { confidence: data.confidence }
      : {}),
  };
}
export function feedbackTerms(value: string): string[] {
  return [
    ...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ].sort();
}
export function feedbackSimilarity(left: string, right: string): number {
  const a = new Set(feedbackTerms(left)),
    b = new Set(feedbackTerms(right));
  const union = new Set([...a, ...b]);
  return union.size
    ? [...a].filter((value) => b.has(value)).length / union.size
    : 0;
}
export interface RetrieveFeedbackInput {
  itemId: string;
  query: string;
  offered: GenerationOutput['offered'];
  promptVersion: string;
  configurationVersion: string;
  model: { provider: string; model: string; version: string };
}
/** Owning ingestion ledger. Generic LearningMemory's success/ancestor fallback semantics are deliberately not used. */
export class IntakeFeedbackService {
  private readonly execution: IntakeExecutionService;
  private readonly config: FeedbackConfiguration;
  private readonly lineage = new Set<string>();
  private exampleChecks = 0;
  constructor(
    private readonly options: IngestionOptions,
    execution?: IntakeExecutionService,
  ) {
    if (!options.execution || !options.feedback)
      throw new Error('Feedback not configured');
    this.config = { ...options.feedback };
    this.execution =
      execution ?? new IntakeExecutionService(options, options.execution);
    text(this.config.version);
    for (const [value, max] of [
      [this.config.maxExamples, 20],
      [this.config.maxScan, 1000],
      [this.config.maxBytes, 1000000],
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > max)
        throw new Error('Invalid feedback limits');
    if (
      !Number.isFinite(this.config.minimumSimilarity) ||
      this.config.minimumSimilarity < 0.2 ||
      this.config.minimumSimilarity > 1
    )
      throw new Error('Invalid feedback similarity');
  }
  private configurationDigest() {
    const { version, maxExamples, maxScan, maxBytes, minimumSimilarity } =
      this.config;
    return digest({
      version,
      maxExamples,
      maxScan,
      maxBytes,
      minimumSimilarity,
    });
  }
  private scope() {
    return this.options.scope;
  }
  private async rows(
    db: DatabaseInterface,
    where: string,
    params: unknown[] = [],
  ): Promise<Row[]> {
    const scope = this.scope();
    return (
      await db.query(
        `SELECT * FROM intake_feedback WHERE tenant_id=? AND confidential_scope_id=? AND ${where}`,
        scope.tenantId,
        scope.confidentialScopeId,
        ...params,
      )
    ).rows;
  }
  private async authorize(
    ctx: FeedbackActionContext,
    operation: 'capture' | 'retrieve' | 'suggest' | 'adopt',
  ) {
    if (
      !(await this.config.authorize({
        db: ctx.db,
        scope: this.scope(),
        itemId: ctx.itemId,
        operation,
      }))
    )
      throw new Error('Feedback unavailable');
  }
  private checkBinding(input: FeedbackBinding, ctx: FeedbackActionContext) {
    if (
      input.itemId !== ctx.itemId ||
      input.actionId !== ctx.review.actionId ||
      input.expectedRevision !== ctx.review.revision ||
      input.expectedReviewVersion !== ctx.review.reviewVersion ||
      input.bindingHash !== ctx.review.bindingHash
    )
      throw new Error('Stale feedback binding');
  }
  private async insert(
    ctx: FeedbackActionContext,
    key: string,
    kind: string,
    data: Row,
    supersedesId: string | null = null,
  ): Promise<Row> {
    const serialized = JSON.stringify(data);
    if (
      Buffer.byteLength(serialized) >
      Math.min(this.config.maxBytes, ctx.context.policy.maxBytes)
    )
      throw new Error('Feedback limit');
    const scope = this.scope(),
      now = (this.options.now?.() ?? new Date()).toISOString();
    const row = {
      id: randomUUID(),
      slug: randomUUID(),
      context: '',
      created_at: now,
      updated_at: now,
      tenant_id: scope.tenantId,
      confidential_scope_id: scope.confidentialScopeId,
      item_id: ctx.itemId,
      request_key: key,
      supersedes_id: supersedesId,
      kind,
      data: serialized,
    };
    return (
      await ctx.db.query(
        `INSERT INTO intake_feedback (${Object.keys(row).join(',')}) VALUES (${Object.keys(
          row,
        )
          .map(() => '?')
          .join(',')}) RETURNING *`,
        ...Object.values(row),
      )
    ).rows[0];
  }
  private receipt(row: Row): FeedbackReceipt {
    return {
      id: String(row.id),
      digest: String(object(row.data).digest),
      kind: row.kind as FeedbackReceipt['kind'],
    };
  }
  private async provenance(ctx: FeedbackActionContext) {
    const output = object(ctx.result.output),
      generation = object(output.proposals),
      pin = object(generation.source),
      provenance = object(generation.provenance);
    if (provenance.feedback) {
      const inherited = object(provenance.feedback);
      const key = ctx.attemptId;
      if (this.lineage.has(key) || this.lineage.size >= 8)
        throw new Error('Feedback lineage unavailable');
      this.lineage.add(key);
      try {
        await this.assertSelection(
          {
            itemId: ctx.itemId,
            query: String(inherited.query),
            offered: generation.offered as GenerationOutput['offered'],
            promptVersion: String(provenance.promptVersion),
            configurationVersion: String(provenance.configurationVersion),
            model: provenance.generative as RetrieveFeedbackInput['model'],
          },
          inherited.selection as unknown as FeedbackReferences,
          ctx.db,
        );
      } finally {
        this.lineage.delete(key);
      }
    }
    const scope = this.scope();
    const [source] = (
      await ctx.db.query(
        'SELECT data,output_digest FROM intake_analysis_attempts WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND id=?',
        scope.tenantId,
        scope.confidentialScopeId,
        ctx.itemId,
        pin.attemptId,
      )
    ).rows;
    if (!source || source.output_digest !== pin.outputDigest)
      throw new Error('Feedback source unavailable');
    const sourceResult = resultData(object(source.data));
    if (digest(sourceResult) !== pin.outputDigest)
      throw new Error('Feedback source integrity');
    const results = object(sourceResult.output).results;
    if (!Array.isArray(results))
      throw new Error('Feedback extraction unavailable');
    const query = results
      .flatMap((entry) => {
        const segments = object(entry).segments;
        return Array.isArray(segments)
          ? segments.map((segment) => String(object(segment).text ?? ''))
          : [];
      })
      .join('\n')
      .slice(0, 4096);
    const model = object(provenance.generative);
    for (const field of ['provider', 'model', 'version']) text(model[field]);
    text(provenance.promptVersion);
    text(provenance.configurationVersion);
    return {
      query,
      model: {
        provider: String(model.provider),
        model: String(model.model),
        version: String(model.version),
      },
      promptVersion: String(provenance.promptVersion),
      configurationVersion: String(provenance.configurationVersion),
      attemptId: ctx.attemptId,
      evidence: object(ctx.analysis).inputs,
      source: pin,
    };
  }
  async record(input: RecordFeedbackInput): Promise<FeedbackReceipt> {
    digest(input);
    text(input.requestId);
    if (
      !['correct', 'incorrect'].includes(input.judgment) ||
      (input.comment !== undefined &&
        (typeof input.comment !== 'string' || input.comment.length > 4000))
    )
      throw new Error('Invalid feedback');
    const frozen = structuredClone(input);
    return this.execution[feedbackActionTransaction](
      input.actionId,
      true,
      async (ctx) => {
        await this.authorize(ctx, 'capture');
        this.checkBinding(frozen, ctx);
        const requestHash = digest(frozen),
          key = `judgment:${frozen.requestId}`;
        const [replay] = await this.rows(
          ctx.db,
          'item_id=? AND request_key=?',
          [ctx.itemId, key],
        );
        if (replay) {
          const data = object(replay.data);
          if (
            data.requestHash !== requestHash ||
            data.reviewer !== this.scope().actorId
          )
            throw new Error('Feedback request conflict');
          return this.receipt(replay);
        }
        if (frozen.supersedesId) {
          const [old] = await this.rows(
            ctx.db,
            'item_id=? AND id=? AND kind=?',
            [ctx.itemId, frozen.supersedesId, 'interpretation'],
          );
          if (
            !old ||
            object(old.data).actionId !== frozen.actionId ||
            (await this.rows(ctx.db, 'supersedes_id=?', [old.id])).length
          )
            throw new Error('Feedback supersession conflict');
        }
        const provenance = await this.provenance(ctx);
        const body = {
          version: 1,
          requestHash,
          reviewer: this.scope().actorId,
          actionId: ctx.review.actionId,
          revision: ctx.review.revision,
          reviewVersion: ctx.review.reviewVersion,
          bindingHash: ctx.review.bindingHash,
          handlerId: ctx.handlerId,
          handlerVersion: ctx.handlerVersion,
          args: ctx.args,
          judgment: frozen.judgment,
          comment: frozen.comment ?? '',
          ...provenance,
        };
        const row = await this.insert(
          ctx,
          key,
          'interpretation',
          { ...body, digest: digest(body) },
          frozen.supersedesId ?? null,
        );
        await this.authorize(ctx, 'capture');
        return this.receipt(row);
      },
    );
  }
  /** Consume a durable owner event idempotently. Never derive correctness from these signals. */
  async observe(input: ObserveFeedbackInput): Promise<FeedbackReceipt> {
    digest(input);
    text(input.eventId);
    if (!['action_decision', 'downstream_outcome'].includes(input.kind))
      throw new Error('Invalid feedback kind');
    return this.execution[feedbackActionTransaction](
      input.actionId,
      true,
      async (ctx) => {
        await this.authorize(ctx, 'capture');
        this.checkBinding(input, ctx);
        const scope = this.scope();
        const table =
          input.kind === 'action_decision'
            ? 'intake_review_decisions'
            : 'intake_executions';
        const [event] = (
          await ctx.db.query(
            `SELECT * FROM ${table} WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND action_id=? AND id=?`,
            scope.tenantId,
            scope.confidentialScopeId,
            ctx.itemId,
            input.actionId,
            input.eventId,
          )
        ).rows;
        if (!event || event.binding_hash !== ctx.review.bindingHash)
          throw new Error('Feedback event unavailable');
        const state =
          input.kind === 'action_decision' ? event.decision : event.state;
        if (
          input.kind === 'downstream_outcome' &&
          !['succeeded', 'failed', 'outcome_unknown'].includes(String(state))
        )
          throw new Error('Outcome is not terminal');
        const body = {
          version: 1,
          eventId: input.eventId,
          actionId: input.actionId,
          revision: ctx.review.revision,
          reviewer:
            input.kind === 'action_decision'
              ? object(event.data).reviewer
              : null,
          observedBy: this.scope().actorId,
          principalId: object(event.data).principalId ?? null,
          signal: state,
          provenance: await this.provenance(ctx),
        };
        const key = `event:${input.kind}:${input.eventId}:${String(state)}`;
        const [existing] = await this.rows(
          ctx.db,
          'item_id=? AND request_key=?',
          [ctx.itemId, key],
        );
        if (existing) return this.receipt(existing);
        const row = await this.insert(ctx, key, input.kind, {
          ...body,
          digest: digest(body),
        });
        await this.authorize(ctx, 'capture');
        return this.receipt(row);
      },
    );
  }
  private async example(
    row: Row,
    input: RetrieveFeedbackInput,
    executor?: DatabaseInterface,
  ): Promise<FeedbackExample | undefined> {
    if (++this.exampleChecks > this.config.maxScan) return undefined;
    try {
      const candidate = object(row.data);
      // Retention deliberately redacts ledger payloads. Reject tombstones before
      // issuing a UUID query: catching a PostgreSQL cast error cannot repair its transaction.
      if (
        typeof candidate.actionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          candidate.actionId,
        )
      )
        return undefined;
      return await this.execution[feedbackActionTransaction](
        candidate.actionId,
        false,
        async (ctx) => {
          await this.authorize(ctx, 'retrieve');
          await this.provenance(ctx);
          const [current] = await this.rows(
            ctx.db,
            'id=? AND kind=? AND NOT EXISTS (SELECT 1 FROM intake_feedback successor WHERE successor.tenant_id=intake_feedback.tenant_id AND successor.confidential_scope_id=intake_feedback.confidential_scope_id AND successor.supersedes_id=intake_feedback.id)',
            [row.id, 'interpretation'],
          );
          if (!current) return undefined;
          const data = object(current.data);
          const { digest: stored, ...body } = data;
          if (digest(body) !== stored) throw new Error('Feedback integrity');
          if (
            data.revision !== ctx.review.revision ||
            data.bindingHash !== ctx.review.bindingHash ||
            data.attemptId !== ctx.attemptId ||
            data.promptVersion !== input.promptVersion ||
            data.configurationVersion !== input.configurationVersion ||
            digest(data.model) !== digest(input.model)
          )
            return undefined;
          const offered = input.offered.find(
            (entry) =>
              entry.handler.id === data.handlerId &&
              entry.handler.version === data.handlerVersion,
          );
          if (!offered) return undefined;
          const args = object(data.args);
          for (const [field, reference] of Object.entries(
            offered.handler.references,
          )) {
            if (
              reference.kind === 'candidate' &&
              Object.hasOwn(args, field) &&
              !offered.candidates.some(
                (candidate) =>
                  candidate.id === args[field] &&
                  candidate.model === reference.model,
              )
            )
              return undefined;
          }
          return {
            feedbackId: String(current.id),
            digest: String(stored),
            itemId: ctx.itemId,
            actionId: ctx.review.actionId,
            revision: ctx.review.revision,
            handlerId: ctx.handlerId,
            handlerVersion: ctx.handlerVersion,
            judgment: data.judgment as 'correct' | 'incorrect',
            query: String(data.query),
            args,
            model: data.model as FeedbackExample['model'],
            promptVersion: String(data.promptVersion),
            configurationVersion: String(data.configurationVersion),
          };
        },
        executor,
      );
    } catch {
      return undefined;
    }
  }
  async retrieve(
    input: RetrieveFeedbackInput,
    executor?: DatabaseInterface,
  ): Promise<FeedbackSelection> {
    text(input.query, 4096);
    const offered = input.offered[0];
    if (!offered)
      return {
        version: this.config.version,
        configurationDigest: this.configurationDigest(),
        examples: [],
      };
    const work = async (
      context: import('./execution-contracts.js').HandlerContext,
    ) => {
      const authorize = async () => {
        if (
          !(await this.config.authorize({
            db: context.db,
            scope: this.scope(),
            itemId: input.itemId,
            operation: 'retrieve',
          }))
        )
          throw new Error('Feedback unavailable');
      };
      await authorize();
      const scope = this.scope();
      const rows = (
        await context.db.query(
          "SELECT * FROM intake_feedback WHERE tenant_id=? AND confidential_scope_id=? AND kind='interpretation' ORDER BY id LIMIT ?",
          scope.tenantId,
          scope.confidentialScopeId,
          this.config.maxScan,
        )
      ).rows;
      const ranked: Array<{ example: FeedbackExample; score: number }> = [];
      for (const row of rows) {
        const example = await this.example(row, input, context.db);
        if (!example) continue;
        const score = feedbackSimilarity(input.query, example.query);
        if (score >= this.config.minimumSimilarity)
          ranked.push({ example, score });
      }
      ranked.sort(
        (a, b) =>
          b.score - a.score ||
          a.example.feedbackId.localeCompare(b.example.feedbackId),
      );
      const selection = {
        version: this.config.version,
        configurationDigest: this.configurationDigest(),
        examples: ranked
          .slice(0, this.config.maxExamples)
          .map((entry) => entry.example),
      };
      if (
        Buffer.byteLength(JSON.stringify(selection)) >
        Math.min(this.config.maxBytes, context.policy.maxBytes)
      )
        throw new Error('Feedback limit');
      await authorize();
      return selection;
    };
    return executor
      ? this.execution[feedbackDiscoveryContext](
          executor,
          input.itemId,
          offered.handler.id,
          offered.handler.version,
          work,
        )
      : this.execution.withDiscoveryContext(
          input.itemId,
          offered.handler.id,
          offered.handler.version,
          work,
        );
  }
  async assertSelection(
    input: RetrieveFeedbackInput,
    selection: FeedbackReferences,
    executor?: DatabaseInterface,
  ): Promise<void> {
    if (
      selection.version !== this.config.version ||
      selection.configurationDigest !== this.configurationDigest() ||
      !Array.isArray(selection.examples) ||
      selection.examples.length > this.config.maxExamples ||
      new Set(selection.examples.map((example) => example.feedbackId)).size !==
        selection.examples.length ||
      Buffer.byteLength(JSON.stringify(selection)) > this.config.maxBytes
    )
      throw new Error('Feedback eligibility changed');
    const offered = input.offered[0];
    if (!offered) {
      if (selection.examples.length)
        throw new Error('Feedback eligibility changed');
      return;
    }
    const work = async (
      context: import('./execution-contracts.js').HandlerContext,
    ) => {
      if (
        !(await this.config.authorize({
          db: context.db,
          scope: this.scope(),
          itemId: input.itemId,
          operation: 'retrieve',
        }))
      )
        throw new Error('Feedback unavailable');
      for (const expected of selection.examples) {
        const [row] = await this.rows(context.db, 'id=? AND kind=?', [
          expected.feedbackId,
          'interpretation',
        ]);
        const current = row
          ? await this.example(row, input, context.db)
          : undefined;
        if (
          !current ||
          current.digest !== expected.digest ||
          feedbackSimilarity(input.query, current.query) <
            this.config.minimumSimilarity
        )
          throw new Error('Feedback eligibility changed');
      }
      if (
        !(await this.config.authorize({
          db: context.db,
          scope: this.scope(),
          itemId: input.itemId,
          operation: 'retrieve',
        }))
      )
        throw new Error('Feedback unavailable');
    };
    if (executor)
      await this.execution[feedbackDiscoveryContext](
        executor,
        input.itemId,
        offered.handler.id,
        offered.handler.version,
        work,
      );
    else
      await this.execution.withDiscoveryContext(
        input.itemId,
        offered.handler.id,
        offered.handler.version,
        work,
      );
  }
  private async support(
    ctx: FeedbackActionContext,
    ids: string[],
  ): Promise<Array<{ id: string; digest: string; query: string }>> {
    if (
      !Array.isArray(ids) ||
      ids.length < 2 ||
      ids.length > this.config.maxExamples ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Insufficient rule evidence');
    const provenance = await this.provenance(ctx),
      origins = new Set<string>(),
      result: Array<{ id: string; digest: string; query: string }> = [];
    for (const id of [...ids].sort()) {
      text(id);
      const [row] = await this.rows(ctx.db, 'id=? AND kind=?', [
        id,
        'interpretation',
      ]);
      if (!row) throw new Error('Rule evidence unavailable');
      const data = object(row.data);
      await this.execution[feedbackActionTransaction](
        String(data.actionId),
        false,
        async (source) => {
          await this.authorize(source, 'retrieve');
          await this.provenance(source);
          if (origins.has(source.itemId))
            throw new Error('Independent rule evidence required');
          origins.add(source.itemId);
          const { digest: stored, ...body } = data;
          if (
            digest(body) !== stored ||
            data.judgment !== 'correct' ||
            data.revision !== source.review.revision ||
            data.bindingHash !== source.review.bindingHash ||
            data.handlerId !== ctx.handlerId ||
            data.handlerVersion !== ctx.handlerVersion ||
            digest(data.args) !== digest(ctx.args) ||
            data.promptVersion !== provenance.promptVersion ||
            data.configurationVersion !== provenance.configurationVersion ||
            digest(data.model) !== digest(provenance.model) ||
            (await this.rows(ctx.db, 'supersedes_id=?', [id])).length
          )
            throw new Error('Rule evidence unavailable');
          result.push({
            id,
            digest: String(stored),
            query: String(data.query),
          });
        },
        ctx.db,
      );
    }
    return result;
  }
  async suggest(input: SuggestRuleInput): Promise<RuleSuggestion> {
    digest(input);
    text(input.requestId);
    if (!this.config.policy) throw new Error('Rule policy owner unavailable');
    return this.execution[feedbackActionTransaction](
      input.actionId,
      true,
      async (ctx) => {
        this.checkBinding(input, ctx);
        await this.authorize(ctx, 'suggest');
        const support = await this.support(ctx, input.supportingFeedbackIds);
        const terms = feedbackTerms(support[0].query).filter((term) =>
          support.every((example) =>
            feedbackTerms(example.query).includes(term),
          ),
        );
        if (!terms.length) throw new Error('No shared routing evidence');
        const rule: RoutingRule = {
          handlerId: ctx.handlerId,
          handlerVersion: ctx.handlerVersion,
          matchTerms: terms,
          args: ctx.args,
        };
        const preview = await this.config.policy!.preview({
          db: ctx.db,
          scope: this.scope(),
          rule: structuredClone(rule),
        });
        text(preview.version);
        text(preview.preview, 4000);
        const body = {
          version: 1,
          actionId: input.actionId,
          revision: ctx.review.revision,
          bindingHash: ctx.review.bindingHash,
          rule,
          supportingFeedback: support.map(({ id, digest }) => ({ id, digest })),
          expectedPolicyVersion: preview.version,
          preview: preview.preview,
          reviewer: this.scope().actorId,
          requestHash: digest(input),
        };
        const key = `rule:${input.requestId}`;
        let [row] = await this.rows(ctx.db, 'item_id=? AND request_key=?', [
          ctx.itemId,
          key,
        ]);
        if (row) {
          if (object(row.data).requestHash !== body.requestHash)
            throw new Error('Rule request conflict');
        } else
          row = await this.insert(ctx, key, 'rule_suggestion', {
            ...body,
            digest: digest(body),
          });
        await this.authorize(ctx, 'suggest');
        return this.ruleDTO(row);
      },
    );
  }
  private ruleDTO(row: Row): RuleSuggestion {
    const data = object(row.data);
    return {
      id: String(row.id),
      digest: String(data.digest),
      itemId: String(row.item_id),
      rule: data.rule as unknown as RoutingRule,
      supportingFeedback:
        data.supportingFeedback as RuleSuggestion['supportingFeedback'],
      expectedPolicyVersion: String(data.expectedPolicyVersion),
      preview: String(data.preview),
      automaticActionEligible: false,
    };
  }
  private async rule(ctx: FeedbackActionContext, id: string): Promise<Row> {
    const [row] = await this.rows(ctx.db, 'item_id=? AND id=? AND kind=?', [
      ctx.itemId,
      id,
      'rule_suggestion',
    ]);
    if (!row) throw new Error('Rule unavailable');
    const data = object(row.data),
      { digest: stored, ...body } = data;
    if (
      digest(body) !== stored ||
      data.actionId !== ctx.review.actionId ||
      data.revision !== ctx.review.revision ||
      data.bindingHash !== ctx.review.bindingHash
    )
      throw new Error('Stale rule');
    const support = data.supportingFeedback as Array<{
      id: string;
      digest: string;
    }>;
    const current = await this.support(
      ctx,
      support.map((entry) => entry.id),
    );
    if (
      digest(current.map(({ id, digest }) => ({ id, digest }))) !==
      digest(support)
    )
      throw new Error('Rule evidence changed');
    return row;
  }
  async readRule(input: ReadRuleInput): Promise<RuleSuggestion> {
    return this.execution[feedbackActionTransaction](
      input.actionId,
      true,
      async (ctx) => {
        this.checkBinding(input, ctx);
        await this.authorize(ctx, 'suggest');
        const suggestion = this.ruleDTO(
          await this.rule(ctx, input.suggestionId),
        );
        if (!this.config.policy)
          throw new Error('Rule policy owner unavailable');
        const current = await this.config.policy.preview({
          db: ctx.db,
          scope: this.scope(),
          rule: structuredClone(suggestion.rule),
        });
        if (
          current.version !== suggestion.expectedPolicyVersion ||
          current.preview !== suggestion.preview
        )
          throw new Error('Rule policy changed');
        await this.authorize(ctx, 'suggest');
        return suggestion;
      },
    );
  }
  async adopt(input: AdoptRuleInput): Promise<RuleAdoption> {
    digest(input);
    text(input.requestId);
    if (!this.config.policy) throw new Error('Rule policy owner unavailable');
    return this.execution[feedbackActionTransaction](
      input.actionId,
      true,
      async (ctx) => {
        this.checkBinding(input, ctx);
        await this.authorize(ctx, 'adopt');
        const row = await this.rule(ctx, input.suggestionId),
          suggestion = this.ruleDTO(row);
        if (
          input.expectedDigest !== suggestion.digest ||
          input.expectedPolicyVersion !== suggestion.expectedPolicyVersion
        )
          throw new Error('Stale rule');
        const requestHash = digest(input),
          key = `adopt:${input.requestId}`;
        const [replay] = await this.rows(
          ctx.db,
          'item_id=? AND request_key=?',
          [ctx.itemId, key],
        );
        if (replay) {
          const data = object(replay.data);
          if (
            data.requestHash !== requestHash ||
            data.reviewer !== this.scope().actorId
          )
            throw new Error('Rule request conflict');
          return {
            id: String(replay.id),
            policyVersion: String(data.policyVersion),
            auditId: String(data.auditId),
            automaticActionEligible: false,
          };
        }
        const current = await this.config.policy!.preview({
          db: ctx.db,
          scope: this.scope(),
          rule: structuredClone(suggestion.rule),
        });
        if (current.version !== input.expectedPolicyVersion)
          throw new Error('Policy version changed');
        const applied = await this.config.policy!.adopt({
          db: ctx.db,
          scope: this.scope(),
          rule: structuredClone(suggestion.rule),
          expectedVersion: input.expectedPolicyVersion,
          requestId: input.requestId,
        });
        text(applied.version);
        text(applied.auditId);
        if (applied.version === input.expectedPolicyVersion)
          throw new Error('Policy version did not advance');
        const verified = await this.config.policy!.preview({
          db: ctx.db,
          scope: this.scope(),
          rule: structuredClone(suggestion.rule),
        });
        if (verified.version !== applied.version)
          throw new Error('Policy adoption mismatch');
        const body = {
          version: 1,
          requestHash,
          suggestionId: suggestion.id,
          suggestionDigest: suggestion.digest,
          previousPolicyVersion: input.expectedPolicyVersion,
          policyVersion: applied.version,
          auditId: applied.auditId,
          reviewer: this.scope().actorId,
          automaticActionEligible: false,
        };
        const saved = await this.insert(ctx, key, 'rule_adoption', {
          ...body,
          digest: digest(body),
        });
        await this.authorize(ctx, 'adopt');
        return {
          id: String(saved.id),
          policyVersion: applied.version,
          auditId: applied.auditId,
          automaticActionEligible: false,
        };
      },
    );
  }
}

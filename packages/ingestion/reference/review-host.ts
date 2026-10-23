/** Maintained authenticated application fixture. Not a published ingestion runtime. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { Contents } from '@happyvertical/smrt-content';
import {
  getTestDatabase,
  isEmbeddedDatabase,
  SmrtObject,
  smrt,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { IntakeValues, ReviewInput } from '../src/execution-dto.js';
import type { ExtractionRequest } from '../src/extraction-types.js';
import type { FeedbackConfiguration } from '../src/feedback-contracts.js';
import * as models from '../src/models.js';
import type { GenerationOutput } from '../src/proposal-dto.js';
import { HandlerArgumentsInvalidError } from '../src/proposal-errors.js';
import type {
  Assignment,
  InboxEntry,
  InboxState,
  ItemReviewView,
  LogicalSplitInput,
  ReviewerInstructionInput,
} from '../src/review-dto.js';
import { createIntakeReviewHost } from '../src/review-host.js';
import { loadInstructionView } from '../src/review-instruction-view.js';
import type { AnalysisLease, IngestionOptions } from '../src/server.js';
import {
  createSDKExtractionAdapter,
  createSourceDeliveryHandler,
  extractAnalysis,
  IngestionService,
  ReviewerInstructionInvalidError,
  ReviewerInstructionStaleError,
} from '../src/server.js';
import {
  ATTACH,
  assertReferenceTarget,
  CREATE,
  DOCUMENT,
  referenceHandlers,
} from './handlers.js';
import { loadReviewAnalysis } from './review-analysis.js';
import { loadReviewSummary } from './review-summary.js';

export const REVIEW_TENANT = '11111111-1111-4111-8111-111111111111';
const principalId = '33333333-3333-4333-8333-333333333333';
const limits = {
  maxBytes: 1_000_000,
  maxPages: 10,
  maxPixels: 1_000_000,
  maxOutputBytes: 100_000,
  timeoutMs: 15000,
  maxTokens: 1000,
  workerHeapMb: 256,
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
export interface ReviewSession {
  actorId: string;
  tenantId: string;
  confidentialScopeId: string;
}
@smrt({ api: false, cli: false, mcp: false })
export class ReferenceReviewWorker extends SmrtObject {
  static host: ReferenceReviewHost | undefined;
  @backgroundEligible()
  async process(input: { itemId: string }): Promise<void> {
    const host = ReferenceReviewWorker.host;
    if (!host) throw new Error('Reference worker is not configured');
    const scope = {
      actorId: 'owner',
      tenantId: REVIEW_TENANT,
      confidentialScopeId: 'private',
    };
    const { service } = await host.service(scope);
    const item = await service.getItem(input.itemId);
    if (item.analysisRevision === 0) await host.process(scope, input.itemId);
    else if (item.processingState === 'queued')
      await host.process(scope, input.itemId, item.analysisRevision);
  }
}
/** Trusted fixture deployment options; never accepted from an HTTP/callback payload. */
export interface ReferenceReviewHostOptions {
  database?: Pick<
    NonNullable<Parameters<typeof getTestDatabase>[0]>,
    'type' | 'url' | 'db'
  >;
  proposals?: IngestionOptions['proposals'];
  proposalPolicy?: {
    version: string;
    providers: string[];
    maxBytes: number;
    leaseMs: number;
  };
  extraction?: {
    configuration: Pick<ExtractionRequest, 'limits' | 'configurationRevision'>;
    run(service: IngestionService, lease: AnalysisLease): Promise<unknown>;
  };
  feedback?: FeedbackConfiguration;
}
export class ReferenceReviewHost {
  constructor(
    readonly db: DatabaseInterface,
    private readonly root: string,
    private readonly hostOptions: ReferenceReviewHostOptions = {},
  ) {}
  /** Fixture deployment migration, invoked explicitly before constructing the request handler. */
  static async provision(
    root: string,
    options: ReferenceReviewHostOptions = {},
  ): Promise<ReferenceReviewHost> {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: `file:${join(root, 'review.sqlite')}`,
      ...options.database,
      classes,
    });
    try {
      await db.query(
        'CREATE TABLE IF NOT EXISTS review_assignments (tenant_id TEXT NOT NULL,item_id TEXT NOT NULL,assignee_id TEXT,version INTEGER NOT NULL,request_id TEXT NOT NULL,request_digest TEXT NOT NULL,PRIMARY KEY(tenant_id,item_id))',
      );
      await db.query(
        'CREATE TABLE IF NOT EXISTS review_grants (actor_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)',
      );
      for (const actor of ['owner', 'reviewer'])
        await db.query(
          'INSERT INTO review_grants(actor_id,enabled) VALUES(?,1) ON CONFLICT(actor_id) DO NOTHING',
          actor,
        );
      const host = new ReferenceReviewHost(db, root, options);
      ReferenceReviewWorker.host = host;
      return host;
    } catch (error) {
      await db.close?.();
      throw error;
    }
  }
  async revoke(actorId: string) {
    await this.db.query(
      'UPDATE review_grants SET enabled=0 WHERE actor_id=?',
      actorId,
    );
  }
  private async allowed(scope: ReviewSession, db = this.db) {
    if (
      scope.tenantId !== REVIEW_TENANT ||
      scope.confidentialScopeId !== 'private' ||
      !['owner', 'reviewer'].includes(scope.actorId)
    )
      return false;
    const result = await db.query(
      'UPDATE review_grants SET actor_id=actor_id WHERE actor_id=? AND enabled=1 RETURNING actor_id',
      scope.actorId,
    );
    return result.rows.length === 1;
  }
  async service(scope: ReviewSession) {
    const handlers = referenceHandlers();
    for (const handler of handlers)
      handler.discovery = {
        mediaTypes: [
          'text/plain',
          'application/pdf',
          'application/json',
          'image/png',
          'image/jpeg',
          'audio/wav',
        ],
        references:
          handler.id === ATTACH
            ? {
                contentId: { kind: 'candidate', model: DOCUMENT },
                evidenceId: { kind: 'evidence' },
              }
            : {},
      };
    handlers[1].discovery!.candidates = async (_query, context, page) => {
      const rows = (
        await context.db.query(
          'SELECT id,title,updated_at FROM contents WHERE tenant_id=? AND context=? ORDER BY id LIMIT ?',
          context.scope.tenantId,
          context.scope.confidentialScopeId,
          page.limit + 1,
        )
      ).rows;
      return {
        items: rows.slice(0, page.limit).map((row) => ({
          model: DOCUMENT,
          id: String(row.id),
          revision: new Date(row.updated_at as string).toISOString(),
          label: String(row.title),
        })),
        hasMore: rows.length > page.limit,
      };
    };
    const operations = handlers.map(
      (h) =>
        `${h.operation.model}:${h.operation.action}@${h.operation.version}`,
    );
    const options: IngestionOptions = {
      ...(this.hostOptions.feedback
        ? { feedback: this.hostOptions.feedback }
        : {}),
      db: this.db,
      assets: await createAssetRuntime({
        db: this.db,
        storage: join(this.root, 'assets'),
      }),
      scope,
      authorize: async ({ scope: current, db }) => this.allowed(current, db),
      jobTarget: { objectType: 'ReferenceReviewWorker', method: 'process' },
      purgeDerived: async ({ tenantId, itemId }) => {
        await this.db.query(
          'DELETE FROM review_assignments WHERE tenant_id=? AND item_id=?',
          tenantId,
          itemId,
        );
      },
      execution: {
        handlers,
        assertTarget: assertReferenceTarget,
        authorize: async ({ scope: current, db }) => ({
          allowed: await this.allowed(current, db),
          reviewer: true,
          principalId,
          permissions: ['contents.create', 'contents.addAsset'],
          mutationBoundary: 'serialized',
          policy: [
            {
              version: this.hostOptions.proposalPolicy?.version ?? 'app1',
              handlers: handlers.map((h) => h.id),
              operations,
              providers: this.hostOptions.proposalPolicy?.providers ?? [
                'fixture',
              ],
              reviewers: ['owner', 'reviewer'],
              access: ['private'],
              requireReview: true,
              maxBytes: this.hostOptions.proposalPolicy?.maxBytes ?? 100000,
              leaseMs: this.hostOptions.proposalPolicy?.leaseMs ?? 10000,
            },
            { version: 'tenant1' },
            { version: 'source1' },
          ],
        }),
      },
      proposals: this.hostOptions.proposals ?? {
        version: 'review-fixture1',
        promptVersion: 'review-fixture1',
        limits: {
          maxHandlers: 10,
          maxCandidates: 10,
          maxSuggestions: 10,
          maxInputBytes: 100000,
          maxOutputBytes: 100000,
          maxQueryLength: 1000,
          timeoutMs: 5000,
        },
        generator: {
          identity: {
            provider: 'fixture',
            model: 'deterministic',
            version: '1',
          },
          generate: async (input) => {
            const part =
              input.evidence.find(
                (e) =>
                  e.segments.some((s) => s.text.trim()) &&
                  e.mediaType !== 'application/json',
              ) ?? input.evidence[0];
            const body = part?.segments.map((s) => s.text).join('\n') ?? '';
            // A deterministic incomplete suggestion: the marker leaves the
            // required title unfilled so the browser proof can complete it.
            const incomplete = body.includes('[[missing-title]]');
            return {
              completion: 'complete',
              output: {
                outcome: 'proposals',
                suggestions: part?.segments.length
                  ? [
                      {
                        handlerId: CREATE,
                        handlerVersion: '1',
                        args: {
                          ...(incomplete
                            ? {}
                            : { title: 'Reviewed intake draft' }),
                          body,
                        },
                        evidence: [
                          {
                            evidenceId: part.evidenceId,
                            location: part.segments[0].location,
                          },
                        ],
                        alternatives: [],
                        missingFields: incomplete ? ['title'] : [],
                        explanation:
                          'Deterministic fixture suggestion from retained extracted text.',
                      },
                    ]
                  : [],
                splits: input.humanCorrection
                  ? [
                      {
                        evidenceId: input.humanCorrection.evidenceId,
                        groups: input.humanCorrection.groups,
                      },
                    ]
                  : part?.mediaType === 'application/pdf'
                    ? [
                        {
                          evidenceId: part.evidenceId,
                          groups: part.segments
                            .filter(
                              (segment) => segment.location.kind === 'page',
                            )
                            .map((segment) => [
                              Reflect.get(segment.location, 'page'),
                            ]),
                        },
                      ]
                    : [],
              },
            };
          },
        },
      },
    };
    return {
      service: new IngestionService(options),
      options,
      operations,
      handlers,
    };
  }
  async upload(scope: ReviewSession, request: Request) {
    const { service, operations, handlers } = await this.service(scope);
    const now = Date.now();
    const handler = createSourceDeliveryHandler({
      authenticate: async () =>
        (await this.allowed(scope))
          ? {
              enabled: true,
              service,
              sourceId: 'browser-upload',
              sourceVersion: '1',
              capturedCeiling: {
                execution: {
                  principalId,
                  permissions: ['contents.create', 'contents.addAsset'],
                  handlers: handlers.map((h) => h.id),
                  operations,
                },
              },
              retention: {
                version: '1',
                expiresAt: new Date(now + 86400000),
                replayUntil: new Date(now + 172800000),
                acceptAfter: new Date(now - 60000),
              },
              limits: {
                maxBytes: 1000000,
                maxParts: 10,
                maxAttempts: 3,
                leaseMs: 60000,
                maxOutputBytes: 100000,
              },
              allowedMediaTypes: [
                'text/plain',
                'application/pdf',
                'application/json',
                'image/png',
                'image/jpeg',
                'audio/wav',
              ],
              maxRequestBytes: 1100000,
            }
          : null,
    });
    const response = await handler(request);
    const result = await response.json();
    if (!response.ok || !result.itemId) throw new Error('Upload unavailable');
    await this.process(scope, result.itemId);
    return { itemId: String(result.itemId) };
  }
  async process(scope: ReviewSession, itemId: string, revision?: number) {
    const { service } = await this.service(scope);
    const analysis = revision
      ? { revision }
      : await service.analyze(
          itemId,
          {
            stage: 'extract',
            extraction: this.hostOptions.extraction?.configuration ?? {
              configurationRevision: 'review1',
              limits,
            },
          },
          randomUUID(),
        );
    const lease = await service.claimAnalysis(
      itemId,
      analysis.revision,
      'reference-browser-extractor',
    );
    if (!lease) return;
    const frozen = await service.getAnalysisInput(lease);
    if (frozen.configuration.stage === 'interpret') {
      await service.generateProposals(lease);
      return;
    }
    if (this.hostOptions.extraction) {
      await this.hostOptions.extraction.run(service, lease);
    } else {
      const adapter = createSDKExtractionAdapter({
        nativeMemoryIsolation: 'host-enforced',
        pdf: {
          provider: 'unpdf',
          identity: {
            provider: 'unpdf',
            model: 'embedded-text',
            version: '0.65.9',
          },
        },
      });
      await extractAnalysis(service, lease, adapter, {
        configurationRevision: 'review1',
        limits,
      });
    }
    const processing = await service.getItem(itemId);
    if (!['completed', 'partial'].includes(processing.processingState)) return;
    const source = await service.getCompletedAnalysis(itemId, lease.attemptId);
    if (!['completed', 'partial'].includes(source.result.status)) return;
    const config = await service.prepareGeneration(itemId, lease.attemptId);
    const generation = await service.analyze(
      itemId,
      config,
      `generation:${lease.attemptId}`,
    );
    const next = await service.claimAnalysis(
      itemId,
      generation.revision,
      'reference-browser-generator',
    );
    if (next) await service.generateProposals(next);
  }
  async assignment(scope: ReviewSession, itemId: string): Promise<Assignment> {
    const { service } = await this.service(scope);
    await service.getItem(itemId);
    const row = (
      await this.db.query(
        'SELECT assignee_id,version FROM review_assignments WHERE tenant_id=? AND item_id=?',
        scope.tenantId,
        itemId,
      )
    ).rows[0];
    return {
      assigneeId: row?.assignee_id ? String(row.assignee_id) : null,
      version: Number(row?.version ?? 0),
    };
  }
  async assign(
    scope: ReviewSession,
    input: {
      itemId: string;
      expectedVersion: number;
      assigneeId: string | null;
      requestId: string;
    },
  ) {
    if (
      scope.actorId !== 'owner' ||
      !(await this.allowed(scope)) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !input.requestId ||
      ![null, 'owner', 'reviewer'].includes(input.assigneeId)
    )
      throw new Error('Assignment unavailable');
    const { service, options } = await this.service(scope);
    await service.getItem(input.itemId);
    const hash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    await withEmbeddedWriteTransaction(
      this.db,
      isEmbeddedDatabase(this.db),
      async (db) => {
        // This host owns the assignment table; the UI never accesses it.
        await new IngestionService({ ...options, db }).getItem(input.itemId);
        await db.query(
          'INSERT INTO review_assignments(tenant_id,item_id,assignee_id,version,request_id,request_digest) VALUES(?,?,NULL,0,?,?) ON CONFLICT(tenant_id,item_id) DO NOTHING',
          scope.tenantId,
          input.itemId,
          '',
          '',
        );
        const row = (
          await db.query(
            'SELECT * FROM review_assignments WHERE tenant_id=? AND item_id=?',
            scope.tenantId,
            input.itemId,
          )
        ).rows[0];
        if (row.request_id === input.requestId) {
          if (row.request_digest !== hash)
            throw new Error('Assignment conflict');
          return;
        }
        const changed = await db.query(
          'UPDATE review_assignments SET assignee_id=?,version=version+1,request_id=?,request_digest=? WHERE tenant_id=? AND item_id=? AND version=? RETURNING version',
          input.assigneeId,
          input.requestId,
          hash,
          scope.tenantId,
          input.itemId,
          input.expectedVersion,
        );
        if (!changed.rows.length) throw new Error('Assignment changed');
      },
    );
  }
  async load(
    scope: ReviewSession,
    itemId: string,
    cursor?: string,
    full = true,
  ): Promise<ItemReviewView> {
    const { service } = await this.service(scope);
    const item = await service.getItem(itemId);
    const initialReviews = await service.listReviews(itemId, { cursor });
    const { analysis } = await loadReviewAnalysis(
      service,
      item,
      initialReviews,
      cursor,
    );
    const { reviews, state } = await loadReviewSummary(service, item, cursor);
    // The inbox projection needs neither original bytes nor the offered catalog.
    const evidence = full ? await service.getEvidence(itemId) : [];
    const views = [];
    for (const part of evidence) {
      const bytes = await service.readEvidence(itemId, part.id);
      views.push({
        evidence: part,
        label: part.partId,
        viewUrl: `/api/original/${itemId}/${part.id}`,
        ...(part.mediaType.startsWith('text/') ||
        part.mediaType === 'application/json'
          ? { text: new TextDecoder().decode(bytes) }
          : {}),
      });
    }
    // The offered catalog grants nothing; a catalog failure (not configured,
    // bound exceeded, denied) only hides the start-action picker.
    let catalog: ItemReviewView['catalog'];
    if (full)
      try {
        catalog = await service.listHandlers(itemId);
      } catch {
        catalog = undefined;
      }
    let disposition: ItemReviewView['disposition'];
    if (full && item.disposition)
      try {
        disposition = await service.getItemDisposition(itemId);
      } catch {
        disposition = undefined;
      }
    await service.getItem(itemId);
    const entry: InboxEntry = {
      item,
      label: `Intake ${item.id.slice(0, 8)}`,
      state,
      assignment: await this.assignment(scope, itemId),
    };
    const instruction = await loadInstructionView(service, itemId, analysis);
    return {
      entry,
      evidence: views,
      analysis,
      ...(catalog ? { catalog } : {}),
      ...(disposition ? { disposition } : {}),
      ...(instruction ? { instruction } : {}),
      ...(analysis?.configuration.stage === 'interpret'
        ? {
            generation: analysis.result.output
              .proposals as unknown as GenerationOutput,
          }
        : {}),
      reviews,
      availability: 'available',
    };
  }
  async list(
    scope: ReviewSession,
    input: {
      state?: InboxState;
      assigneeId?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    const { service } = await this.service(scope);
    const notListing = async (): Promise<never> => {
      throw new Error('Not used for listing');
    };
    // Listing composes the published host, so this reference gets the same
    // paging, scan ceiling, junk-id filtering and assignee fallback as a
    // production host. This host owns review_assignments and supplies the
    // batched reads and the assignee pushdown.
    return createIntakeReviewHost(service, {
      upload: notListing,
      assign: notListing,
      evidence: notListing,
      assignment: (itemId) => this.assignment(scope, itemId),
      assignments: (itemIds) => this.assignments(scope, itemIds),
      assignedItemIds: async (assigneeId) =>
        (
          await this.db.query(
            'SELECT item_id FROM review_assignments WHERE tenant_id=? AND assignee_id=?',
            scope.tenantId,
            assigneeId,
          )
        ).rows.map((row) => String(row.item_id)),
    }).list(input);
  }
  /** One read for a listed page; the page itself is already authorized. */
  async assignments(
    scope: ReviewSession,
    itemIds: string[],
  ): Promise<Map<string, Assignment>> {
    if (!itemIds.length) return new Map();
    const rows = (
      await this.db.query(
        `SELECT item_id,assignee_id,version FROM review_assignments WHERE tenant_id=? AND item_id IN (${itemIds.map(() => '?').join(',')})`,
        scope.tenantId,
        ...itemIds,
      )
    ).rows;
    return new Map(
      rows.map((row) => [
        String(row.item_id),
        {
          assigneeId: row.assignee_id ? String(row.assignee_id) : null,
          version: Number(row.version ?? 0),
        },
      ]),
    );
  }
  async preview(
    scope: ReviewSession,
    input: {
      itemId: string;
      attemptId: string;
      index: number;
      requestId: string;
      args?: IntakeValues;
    },
  ) {
    const { service } = await this.service(scope);
    if (
      !Number.isSafeInteger(input.index) ||
      input.index < 0 ||
      typeof input.attemptId !== 'string' ||
      !input.attemptId ||
      typeof input.requestId !== 'string' ||
      !input.requestId.trim() ||
      (input.args !== undefined &&
        (!input.args ||
          typeof input.args !== 'object' ||
          Array.isArray(input.args)))
    )
      throw new Error('Invalid preview');
    const current = await service.getCompletedAnalysis(
      input.itemId,
      input.attemptId,
    );
    const generation = current.result.output
      .proposals as unknown as GenerationOutput;
    const suggestion = generation?.suggestions[input.index];
    if (
      current.configuration.stage !== 'interpret' ||
      generation?.outcome === 'provider_error' ||
      !suggestion ||
      !['ready_for_review', 'needs_review'].includes(suggestion.disposition)
    )
      throw new Error('Preview unavailable');
    const handler = generation.offered.find(
      ({ handler }) =>
        handler.id === suggestion.handlerId &&
        handler.version === suggestion.handlerVersion,
    )?.handler;
    if (!handler) throw new Error('Preview unavailable');
    const intentionKey = `ui:${input.index}`;
    const actionId =
      handler.kind === 'plan'
        ? undefined
        : await service.createAction(input.itemId, intentionKey, {
            origin: 'generated-proposal',
            intentionKey,
          });
    let cursor: string | undefined,
      expectedRevision = 0;
    do {
      const page = await service.listReviews(input.itemId, { cursor });
      const found = page.actions.find((entry) =>
        handler.kind === 'plan'
          ? (entry.plan?.key ?? entry.stalePlan?.key) === intentionKey
          : entry.review.actionId === actionId,
      );
      if (found) {
        expectedRevision =
          handler.kind === 'plan'
            ? (found.plan?.revision ?? found.stalePlan?.revision ?? 0)
            : found.review.revision;
        break;
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (input.args) {
      // Human-completed arguments use the ordinary explicit preview (#4208).
      const shared = {
        itemId: input.itemId,
        attemptId: input.attemptId,
        expectedRevision,
        requestId: input.requestId,
        handlerId: suggestion.handlerId,
        handlerVersion: suggestion.handlerVersion,
        args: structuredClone(input.args),
      };
      return handler.kind === 'plan'
        ? [
            {
              kind: 'plan' as const,
              review: await service.previewPlan({
                ...shared,
                planKey: intentionKey,
              }),
            },
          ]
        : [
            {
              kind: 'operation' as const,
              review: await service.previewProposal({
                ...shared,
                actionId: actionId as string,
              }),
            },
          ];
    }
    return service.previewGeneratedProposals({
      itemId: input.itemId,
      attemptId: input.attemptId,
      selections: [
        {
          index: input.index,
          intentionKey,
          expectedRevision,
          requestId: input.requestId,
        },
      ],
    });
  }
  /**
   * Review-UI transport for `preview`: only the handler's own refusal of the
   * arguments becomes the correctable `{ rejected: 'invalid' }` result; every
   * other failure (denied, revoked, unavailable, unknown) still throws.
   */
  async previewForReview(
    scope: ReviewSession,
    input: Parameters<ReferenceReviewHost['preview']>[1],
  ): Promise<
    | Awaited<ReturnType<ReferenceReviewHost['preview']>>
    | { rejected: 'invalid' }
  > {
    try {
      return await this.preview(scope, input);
    } catch (error) {
      if (error instanceof HandlerArgumentsInvalidError)
        return { rejected: 'invalid' };
      throw error;
    }
  }
  async decide(scope: ReviewSession, input: ReviewInput) {
    return (await this.service(scope)).service.submitDecision(input);
  }
  async split(scope: ReviewSession, input: LogicalSplitInput) {
    const { service } = await this.service(scope);
    const result = await service.reviseLogicalSplit(input);
    await this.process(scope, input.itemId, result.revision);
  }
  /** Durable record first; the fixture then reinterprets in the background like a job worker. */
  async instruct(scope: ReviewSession, input: ReviewerInstructionInput) {
    const { service } = await this.service(scope);
    let result: Awaited<ReturnType<typeof service.recordReviewerInstruction>>;
    try {
      result = await service.recordReviewerInstruction(input);
    } catch (error) {
      if (error instanceof ReviewerInstructionStaleError)
        return { stale: true as const };
      if (error instanceof ReviewerInstructionInvalidError)
        return { invalid: true as const };
      throw error;
    }
    const pending = this.process(scope, input.itemId, result.revision).catch(
      () => undefined,
    );
    this.background.add(pending);
    void pending.finally(() => this.background.delete(pending));
    return { revision: result.revision };
  }
  /** Tests and shutdown wait for fixture background stages instead of racing them. */
  async settle() {
    while (this.background.size) await Promise.all([...this.background]);
  }
  private readonly background = new Set<Promise<unknown>>();
  async result(scope: ReviewSession, id: string) {
    if (!(await this.allowed(scope))) throw new Error('Unavailable');
    const record = await (await Contents.create({ db: this.db })).get({ id });
    if (
      !record ||
      record.tenantId !== scope.tenantId ||
      record.context !== scope.confidentialScopeId
    )
      throw new Error('Unavailable');
    return {
      id: record.id,
      title: record.title,
      body: record.body,
      status: record.status,
    };
  }
}

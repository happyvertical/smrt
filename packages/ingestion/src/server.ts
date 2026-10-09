import { createHash, randomUUID } from 'node:crypto';
import { Asset, type AssetRuntimeLike } from '@happyvertical/smrt-assets';
import {
  detectEngine,
  isEmbeddedDatabase,
  isTransientDatabaseError,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { SmrtJobCollection } from '@happyvertical/smrt-jobs';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import type {
  AnalysisOutput,
  IntakeEvidenceDTO,
  IntakeFailure,
  IntakeItemDTO,
  IntakeLimits,
  ReceiptResult,
} from './dto.js';
import { generationSnapshotRead } from './execution-internal.js';
import './models.js';
import type {
  IntakeExecutionOptions,
  PreviewPlanInput,
  PreviewProposalInput,
  ReviewInput,
} from './execution-contracts.js';
import type { ProposalConfiguration } from './proposal-contracts.js';
import type {
  CompletedAnalysisSnapshot,
  PreviewGeneratedInput,
} from './proposal-dto.js';
import type { LogicalSplitInput } from './review-dto.js';

/** Authenticated host context. Never construct this from transport JSON. */
export interface IngestionScope {
  tenantId: string;
  actorId: string;
  confidentialScopeId: string;
}
/** A source part is already authenticated by the host/source adapter. */
export interface IntakePart {
  partId: string;
  parentPartId?: string;
  mediaType: string;
  bytes: Uint8Array;
  expectedHash?: string;
  sourceReference?: { owner: string; id: string; version: string };
}
/** Host-resolved delivery and retention policy, never untrusted content labels. */
export interface ReceiveInput {
  sourceId: string;
  sourceVersion: string;
  deliveryKey: string;
  deliveredAt: Date;
  parts: IntakePart[];
  capturedCeiling: Record<string, unknown>;
  retention: {
    version: string;
    expiresAt: Date;
    replayUntil: Date;
    acceptAfter: Date;
  };
  limits: IntakeLimits;
  traceId?: string;
}
/** Durable attempt claim. Its fence and token are verified on every completion. */
export interface AnalysisLease {
  itemId: string;
  analysisId: string;
  attemptId: string;
  revision: number;
  fence: number;
  token: string;
}
/** Trusted integration points; no provider or application-policy implementation. */
export interface IngestionOptions {
  /** Optional server-owned interpretation configuration; independent of execution. */
  proposals?: ProposalConfiguration;
  /** Optional application-owned review/execution catalog and live authority. */
  execution?: IntakeExecutionOptions;
  db: DatabaseInterface;
  assets: AssetRuntimeLike;
  scope: IngestionScope;
  /** Recheck current access for EVERY boundary, including worker completion. */
  authorize(input: {
    scope: IngestionScope;
    operation: 'receive' | 'read' | 'process' | 'delete';
    capturedCeiling: Record<string, unknown>;
    db: DatabaseInterface;
  }): Promise<boolean>;
  /** Registered job handler supplied by the host; dispatch arguments contain IDs only. */
  jobTarget: { objectType: string; method: string };
  /** Purge host-owned embeddings/previews/caches; retries must be idempotent. */
  purgeDerived(input: { tenantId: string; itemId: string }): Promise<void>;
  now?: () => Date;
  /** Fault injection/observability; never changes authority or persistence. */
  checkpoint?: (boundary: string) => Promise<void>;
}

type Row = Record<string, unknown>;
const TABLES = [
  'intake_items',
  'intake_evidence',
  'intake_analyses',
  'intake_analysis_attempts',
  'intake_plans',
  'intake_actions',
  'intake_proposals',
  'intake_review_decisions',
  'intake_executions',
  'intake_feedback',
  'intake_dispatches',
  'intake_deletions',
] as const;
const failures = new Set([
  'unsupported_type',
  'malformed_output',
  'limit',
  'timeout',
  'unavailable',
  'authentication',
  'cancelled',
  'integrity',
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid intake payload');
  return parsed as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`)
      .join(',')}}`;
  }
  throw new Error('Invalid canonical intake value');
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function bytesHash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512)
    throw new Error('Invalid intake identifier');
}
function integer(value: unknown, max = 2_147_483_647): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > max
  )
    throw new Error('Invalid intake limit');
}
function persistedDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
function date(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid intake date');
  return value.toISOString();
}

/** Server-only durable lifecycle. Domain approval/execution remains a later layer. */
export class IngestionService {
  private readonly db: DatabaseInterface;
  private readonly scope: IngestionScope;
  constructor(private readonly options: IngestionOptions) {
    this.db = options.db;
    this.scope = Object.freeze({ ...options.scope });
    if (!uuid.test(this.scope.tenantId))
      throw new Error('Required tenant UUID');
    nonempty(this.scope.actorId);
    nonempty(this.scope.confidentialScopeId);
    const configured = this.db as DatabaseInterface & {
      type?: string;
      config?: { type?: string; url?: string };
    };
    const engine = detectEngine(
      this.db.url || configured.config?.url || '',
      configured.type || configured.config?.type,
    );
    if (!['sqlite', 'postgres'].includes(engine) || !this.db.transaction)
      throw new Error('Ingestion requires transactional SQLite or PostgreSQL');
    nonempty(options.jobTarget.objectType);
    nonempty(options.jobTarget.method);
  }
  private async execution() {
    if (!this.options.execution)
      throw new Error('Intake execution is not configured');
    const { IntakeExecutionService } = await import('./execution.js');
    return new IntakeExecutionService(this.options, this.options.execution);
  }
  async previewProposal(input: PreviewProposalInput) {
    return (await this.execution()).previewProposal(input);
  }
  async submitDecision(input: ReviewInput) {
    return (await this.execution()).submitDecision(input);
  }
  async applyAction(actionId: string) {
    return (await this.execution()).applyAction(actionId);
  }
  async reconcileAction(actionId: string) {
    return (await this.execution()).reconcileAction(actionId);
  }
  async listReviews(
    itemId: string,
    input: { cursor?: string; limit?: number } = {},
  ) {
    return (await this.execution()).listReviews(itemId, input);
  }
  async getAction(actionId: string) {
    return (await this.execution()).getAction(actionId);
  }
  async authorizeAutomatic(actionId: string) {
    return (await this.execution()).authorizeAutomatic(actionId);
  }
  async previewPlan(input: PreviewPlanInput) {
    return (await this.execution()).previewPlan(input);
  }
  async applyPlan(planId: string) {
    return (await this.execution()).applyPlan(planId);
  }
  private async proposals() {
    if (!this.options.proposals)
      throw new Error('Intake proposals are not configured');
    const { IngestionProposalService } = await import('./proposals.js');
    return new IngestionProposalService(
      this,
      this.options,
      this.options.proposals,
    );
  }
  async listHandlers(itemId: string) {
    return (await this.proposals()).listHandlers(itemId);
  }
  async findCandidates(input: {
    itemId: string;
    handlerId: string;
    handlerVersion: string;
    query: string;
    limit?: number;
  }) {
    return (await this.proposals()).findCandidates(input);
  }
  async prepareGeneration(itemId: string, attemptId: string) {
    return (await this.proposals()).prepareGeneration(itemId, attemptId);
  }
  async generateProposals(lease: AnalysisLease) {
    return (await this.proposals()).generate(lease);
  }
  async previewGeneratedProposals(input: PreviewGeneratedInput) {
    return (await this.proposals()).preview(input);
  }
  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  private async point(name: string): Promise<void> {
    await this.options.checkpoint?.(name);
  }
  private async authorize(
    operation: 'receive' | 'read' | 'process' | 'delete',
    data: Row,
    db = this.db,
  ): Promise<void> {
    if (
      !(await this.options.authorize({
        scope: this.scope,
        operation,
        capturedCeiling: object(data.capturedCeiling ?? {}),
        db,
      }))
    )
      throw new Error('Intake unavailable');
  }
  private async rows(
    db: DatabaseInterface,
    table: (typeof TABLES)[number],
    where = '',
    params: unknown[] = [],
  ): Promise<Row[]> {
    return (
      await db.query(
        `SELECT * FROM ${table} WHERE tenant_id = ? AND confidential_scope_id = ?${where ? ` AND ${where}` : ''}`,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        ...params,
      )
    ).rows as Row[];
  }
  private async item(
    id: string,
    operation: 'read' | 'process' | 'delete',
    db = this.db,
    allowExpired = false,
  ): Promise<Row> {
    const [item] = await this.rows(db, 'intake_items', 'id = ?', [id]);
    if (!item) throw new Error('Intake unavailable');
    await this.authorize(operation, object(item.data), db);
    if (
      !allowExpired &&
      (item.visibility !== 'active' ||
        persistedDate(item.expires_at).getTime() <= this.now().getTime())
    )
      throw new Error('Intake unavailable');
    return item;
  }
  private async tx<T>(work: (db: DatabaseInterface) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withEmbeddedWriteTransaction(
          this.db,
          isEmbeddedDatabase(this.db),
          work,
        );
      } catch (error) {
        if (attempt >= 3 || !isTransientDatabaseError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  }
  private async lock(db: DatabaseInterface, itemId: string): Promise<void> {
    const result = await db.query(
      'UPDATE intake_items SET analysis_revision = analysis_revision WHERE tenant_id = ? AND confidential_scope_id = ? AND id = ? RETURNING id',
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
    );
    if (!result.rows.length) throw new Error('Intake unavailable');
  }
  private async insert(
    db: DatabaseInterface,
    table: (typeof TABLES)[number],
    values: Row,
    conflict?: string,
  ): Promise<Row[]> {
    const now = this.now().toISOString();
    const row = {
      id: randomUUID(),
      slug: randomUUID(),
      context: '',
      created_at: now,
      updated_at: now,
      tenant_id: this.scope.tenantId,
      confidential_scope_id: this.scope.confidentialScopeId,
      ...values,
    };
    const keys = Object.keys(row);
    return (
      await db.query(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})${conflict ? ` ON CONFLICT (${conflict}) DO NOTHING` : ''} RETURNING *`,
        ...Object.values(row),
      )
    ).rows as Row[];
  }
  /** Diagnostic only: deploy manifest migrations before starting ingestion. */
  async assertReady(): Promise<void> {
    for (const table of TABLES)
      await this.db.query(`SELECT id FROM ${table} WHERE 1 = 0`);
  }
  /** Preserve every original before acknowledgment; retries retain receipt identity. */
  async receive(input: ReceiveInput): Promise<ReceiptResult> {
    await this.authorize('receive', { capturedCeiling: input.capturedCeiling });
    const now = this.now();
    let parts: Array<IntakePart & { hash: string }>;
    try {
      for (const value of [
        input.sourceId,
        input.sourceVersion,
        input.deliveryKey,
        input.retention.version,
      ])
        nonempty(value);
      for (const value of Object.values(input.limits)) integer(value);
      date(input.deliveredAt);
      date(input.retention.expiresAt);
      date(input.retention.replayUntil);
      date(input.retention.acceptAfter);
      if (
        input.deliveredAt < input.retention.acceptAfter ||
        input.retention.expiresAt <= now ||
        input.retention.replayUntil < input.retention.expiresAt
      )
        return { kind: 'rejected', category: 'expired' };
      if (!input.parts.length || input.parts.length > input.limits.maxParts)
        return { kind: 'rejected', category: 'limit' };
      const ids = new Set<string>();
      let total = 0;
      parts = input.parts.map((part) => {
        nonempty(part.partId);
        nonempty(part.mediaType);
        if (ids.has(part.partId) || !(part.bytes instanceof Uint8Array))
          throw new Error('Invalid part');
        ids.add(part.partId);
        total += part.bytes.byteLength;
        const hash = bytesHash(part.bytes);
        if (part.expectedHash && part.expectedHash !== hash)
          throw new Error('Invalid hash');
        return { ...part, bytes: Buffer.from(part.bytes), hash };
      });
      if (total > input.limits.maxBytes)
        return { kind: 'rejected', category: 'limit' };
      for (const part of parts)
        if (
          part.parentPartId &&
          (!ids.has(part.parentPartId) || part.parentPartId === part.partId)
        )
          throw new Error('Invalid parent');
      for (const part of parts) {
        const seen = new Set([part.partId]);
        let parent = part.parentPartId;
        while (parent) {
          if (seen.has(parent)) throw new Error('Cyclic evidence');
          seen.add(parent);
          parent = parts.find((p) => p.partId === parent)?.parentPartId;
        }
      }
    } catch {
      return { kind: 'rejected', category: 'invalid' };
    }
    const identity = parts
      .map((p) => ({
        partId: p.partId,
        parentPartId: p.parentPartId ?? null,
        mediaType: p.mediaType,
        hash: p.hash,
        length: p.bytes.byteLength,
        sourceReference: p.sourceReference ?? null,
      }))
      .sort((a, b) => a.partId.localeCompare(b.partId));
    const payloadDigest = digest(identity);
    const scopeDigest = digest({
      scope: this.scope,
      ceiling: input.capturedCeiling,
      sourceVersion: input.sourceVersion,
    });
    const reservation = await this.tx(async (db) => {
      await this.authorize(
        'receive',
        { capturedCeiling: input.capturedCeiling },
        db,
      );
      const inserted = await this.insert(
        db,
        'intake_items',
        {
          source_id: input.sourceId,
          source_version: input.sourceVersion,
          delivery_key: input.deliveryKey,
          payload_digest: payloadDigest,
          scope_digest: scopeDigest,
          receipt_state: 'reserved',
          processing_state: 'queued',
          visibility: 'active',
          receipt_version: 1,
          analysis_revision: 0,
          fence: 0,
          lease_token: '',
          lease_until: null,
          expires_at: date(input.retention.expiresAt),
          replay_until: date(input.retention.replayUntil),
          cancelled: false,
          trace_id: input.traceId ?? randomUUID(),
          data: canonical({
            capturedCeiling: input.capturedCeiling,
            limits: input.limits,
            retentionVersion: input.retention.version,
            deliveredAt: date(input.deliveredAt),
          }),
        },
        'tenant_id,source_id,delivery_key',
      );
      const matches = await db.query(
        'SELECT * FROM intake_items WHERE tenant_id = ? AND source_id = ? AND delivery_key = ?',
        this.scope.tenantId,
        input.sourceId,
        input.deliveryKey,
      );
      const item = matches.rows[0] as Row;
      if (
        item.scope_digest !== scopeDigest ||
        item.payload_digest !== payloadDigest
      )
        return { kind: 'conflict' as const };
      if (
        item.visibility !== 'active' ||
        persistedDate(item.replay_until) <= now ||
        persistedDate(item.expires_at) <= now
      )
        return { kind: 'expired' as const };
      if (inserted.length) {
        const evidenceIds = new Map(parts.map((p) => [p.partId, randomUUID()]));
        const ordered = [...parts].sort((a, b) => {
          const depth = (p: IntakePart): number =>
            p.parentPartId
              ? 1 + depth(parts.find((x) => x.partId === p.parentPartId)!)
              : 0;
          return depth(a) - depth(b);
        });
        for (const part of ordered)
          await this.insert(db, 'intake_evidence', {
            id: evidenceIds.get(part.partId),
            item_id: item.id,
            part_id: part.partId,
            parent_evidence_id: part.parentPartId
              ? evidenceIds.get(part.parentPartId)
              : null,
            asset_id: randomUUID(),
            state: 'intent',
            content_hash: part.hash,
            byte_length: part.bytes.byteLength,
            media_type: part.mediaType,
            source_uri: '',
            data: canonical({ sourceReference: part.sourceReference ?? null }),
          });
      }
      return { kind: 'reserved' as const, item, created: !!inserted.length };
    });
    if (reservation.kind !== 'reserved')
      return { kind: 'rejected', category: reservation.kind };
    const item = reservation.item;
    const itemId = String(item.id);
    await this.point('reserved');
    if (item.receipt_state === 'ready') {
      try {
        await this.repairDispatches();
      } catch {
        return { kind: 'retry', category: 'unavailable' };
      }
      return {
        kind: 'duplicate',
        itemId,
        receiptVersion: Number(item.receipt_version),
      };
    }
    const token = randomUUID();
    const claimed = await this.tx((db) =>
      db.query(
        `UPDATE intake_items SET receipt_state = 'preserving', fence = fence + 1, lease_token = ?, lease_until = ? WHERE tenant_id = ? AND confidential_scope_id = ? AND id = ? AND visibility = 'active' AND receipt_state <> 'ready' AND (lease_until IS NULL OR lease_until <= ?) RETURNING fence`,
        token,
        new Date(now.getTime() + input.limits.leaseMs).toISOString(),
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
        now.toISOString(),
      ),
    );
    if (!claimed.rows.length) return { kind: 'retry', category: 'busy' };
    try {
      for (const part of parts) await this.preserve(itemId, part, token);
      await this.point('evidence');
      await this.tx(async (db) => {
        await this.lock(db, itemId);
        await this.item(itemId, 'process', db);
        const evidence = await this.rows(db, 'intake_evidence', 'item_id = ?', [
          itemId,
        ]);
        if (
          evidence.length !== parts.length ||
          evidence.some((e) => e.state !== 'durable')
        )
          throw new Error('Incomplete evidence');
        const updated = await db.query(
          `UPDATE intake_items SET receipt_state='ready',lease_token='',lease_until=NULL WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND lease_token=? AND lease_until>? AND visibility='active' RETURNING id`,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          token,
          this.now().toISOString(),
        );
        if (!updated.rows.length) throw new Error('Lease lost');
        await this.insert(
          db,
          'intake_dispatches',
          {
            item_id: itemId,
            stage: 'analyze',
            revision: 1,
            state: 'pending',
            job_id: '',
            deliveries: 0,
            data: '{}',
          },
          'tenant_id,item_id,stage,revision',
        );
      });
      await this.point('ready');
      await this.repairDispatches();
      await this.point('ack');
      return {
        kind: reservation.created ? 'accepted' : 'duplicate',
        itemId,
        receiptVersion: 1,
      };
    } catch {
      await this.tx((db) =>
        db.query(
          `UPDATE intake_items SET receipt_state='needs_attention',lease_token='',lease_until=NULL WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND lease_token=? AND receipt_state<>'ready'`,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          token,
        ),
      );
      return { kind: 'retry', category: 'unavailable' };
    }
  }
  private async preserve(
    itemId: string,
    part: IntakePart & { hash: string },
    token: string,
  ): Promise<void> {
    const [evidence] = await this.rows(
      this.db,
      'intake_evidence',
      'item_id=? AND part_id=?',
      [itemId, part.partId],
    );
    if (!evidence) throw new Error('Missing storage intent');
    await this.item(itemId, 'process');
    const asset = await withTenant(
      { tenantId: this.scope.tenantId },
      async () => {
        let asset = await this.options.assets.collection.get({
          id: String(evidence.asset_id),
        });
        if (!asset)
          asset = await this.options.assets.collection.create({
            id: String(evidence.asset_id),
            tenantId: this.scope.tenantId,
            name: String(evidence.id),
            mimeType: part.mediaType,
            typeSlug: 'intake',
            statusSlug: 'active',
            sourceUri: '',
          });
        if (asset.tenantId !== this.scope.tenantId)
          throw new Error('Asset unavailable');
        return asset;
      },
    );
    const uri = await this.options.assets.store.planFile(asset, {
      mimeType: part.mediaType,
      typeSlug: 'intake',
    });
    if (evidence.source_uri && evidence.source_uri !== uri)
      throw new Error('Storage plan changed');
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      const item = await this.item(itemId, 'process', db);
      if (
        item.lease_token !== token ||
        persistedDate(item.lease_until) <= this.now()
      )
        throw new Error('Lease lost');
      await db.query(
        'UPDATE intake_evidence SET source_uri=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        uri,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        evidence.id,
      );
    });
    asset.sourceUri = uri;
    await asset.save();
    await this.point('storage_intent');
    await this.options.assets.store.preserveFile(
      asset,
      Buffer.from(part.bytes),
      { mimeType: part.mediaType, typeSlug: 'intake' },
    );
    await this.point('storage');
    const actual = await this.options.assets.store.read(asset);
    if (
      actual.length !== Number(evidence.byte_length) ||
      bytesHash(actual) !== evidence.content_hash
    )
      throw new Error('Storage integrity');
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      const item = await this.item(itemId, 'process', db);
      if (
        item.lease_token !== token ||
        persistedDate(item.lease_until) <= this.now()
      )
        throw new Error('Lease lost');
      await db.query(
        "UPDATE intake_evidence SET state='durable' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        evidence.id,
      );
    });
  }
  /** Repair lost enqueue/mark writes and deleted/failed jobs. Duplicate jobs are safe. */
  async repairDispatches(): Promise<number> {
    let repaired = 0;
    const intents = await this.rows(
      this.db,
      'intake_dispatches',
      "state <> 'completed'",
    );
    const jobs = await SmrtJobCollection.create({ db: this.db });
    for (const intent of intents) {
      const item = await this.item(
        String(intent.item_id),
        'process',
        this.db,
        true,
      );
      if (
        item.visibility !== 'active' ||
        item.cancelled ||
        persistedDate(item.expires_at) <= this.now()
      )
        continue;
      if (
        intent.job_id &&
        Number(intent.revision) === Math.max(1, Number(item.analysis_revision))
      ) {
        const job = await withTenant({ tenantId: this.scope.tenantId }, () =>
          jobs.get({ id: String(intent.job_id) }),
        );
        if (job && ['pending', 'running'].includes(job.status)) continue;
      }
      const allocation = await this.tx(async (db) => {
        await this.lock(db, String(item.id));
        const currentItem = await this.item(String(item.id), 'process', db);
        const [currentIntent] = await this.rows(
          db,
          'intake_dispatches',
          'id=? AND item_id=?',
          [intent.id, item.id],
        );
        if (!currentIntent || currentIntent.state === 'completed') return false;
        // Revision 1 is queued at receipt, before the first analysis exists.
        if (
          currentItem.cancelled ||
          Number(currentIntent.revision) !==
            Math.max(1, Number(currentItem.analysis_revision))
        ) {
          await db.query(
            "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            currentIntent.id,
          );
          return false;
        }
        const limits = object(
          object(currentItem.data).limits,
        ) as unknown as IntakeLimits;
        if (Number(currentIntent.deliveries) >= limits.maxAttempts) {
          await db.query(
            "UPDATE intake_items SET processing_state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            item.id,
          );
          await db.query(
            "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            intent.id,
          );
          return false;
        }
        const result = await db.query(
          "UPDATE intake_dispatches SET deliveries=deliveries+1 WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND state<>'completed' AND deliveries<? RETURNING id",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          currentIntent.id,
          limits.maxAttempts,
        );
        return result.rows.length === 1;
      });
      if (!allocation) continue;
      const job = await withTenant({ tenantId: this.scope.tenantId }, () =>
        jobs.enqueueJob({
          tenantId: this.scope.tenantId,
          objectType: this.options.jobTarget.objectType,
          method: this.options.jobTarget.method,
          args: {
            itemId: intent.item_id,
            revision: Number(intent.revision),
            dispatchId: intent.id,
          },
          queue: 'ingestion',
          maxAttempts: 1,
        }),
      );
      await this.point('enqueued');
      await this.tx((db) =>
        db.query(
          "UPDATE intake_dispatches SET state='delivered',job_id=? WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND state<>'completed'",
          job.id,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          intent.id,
        ),
      );
      repaired++;
    }
    return repaired;
  }
  /** List only authorized active items; omitted items do not contribute counts. */
  async listItems(): Promise<IntakeItemDTO[]> {
    const rows = await this.rows(
      this.db,
      'intake_items',
      "visibility='active' AND expires_at>?",
      [this.now().toISOString()],
    );
    const result: IntakeItemDTO[] = [];
    for (const row of rows) {
      try {
        await this.authorize('read', object(row.data));
        result.push(this.itemDTO(row));
      } catch {
        /* no existence disclosure */
      }
    }
    return result;
  }
  private itemDTO(row: Row): IntakeItemDTO {
    return {
      id: String(row.id),
      receiptState: String(row.receipt_state),
      processingState: String(row.processing_state),
      analysisRevision: Number(row.analysis_revision),
      cancelled: !!row.cancelled,
      traceId: String(row.trace_id),
    };
  }
  async getItem(id: string): Promise<IntakeItemDTO> {
    return this.itemDTO(await this.item(id, 'read'));
  }
  async getEvidence(itemId: string): Promise<IntakeEvidenceDTO[]> {
    await this.item(itemId, 'read');
    return (
      await this.rows(
        this.db,
        'intake_evidence',
        "item_id=? AND state='durable'",
        [itemId],
      )
    ).map((e) => ({
      id: String(e.id),
      partId: String(e.part_id),
      parentEvidenceId: e.parent_evidence_id
        ? String(e.parent_evidence_id)
        : null,
      mediaType: String(e.media_type),
      contentHash: String(e.content_hash),
      byteLength: Number(e.byte_length),
    }));
  }
  async readEvidence(itemId: string, evidenceId: string): Promise<Uint8Array> {
    await this.item(itemId, 'read');
    const [e] = await this.rows(
      this.db,
      'intake_evidence',
      "item_id=? AND id=? AND state='durable'",
      [itemId, evidenceId],
    );
    if (!e) throw new Error('Intake unavailable');
    const asset = await withTenant({ tenantId: this.scope.tenantId }, () =>
      this.options.assets.collection.get({ id: String(e.asset_id) }),
    );
    if (
      !asset ||
      asset.tenantId !== this.scope.tenantId ||
      asset.sourceUri !== e.source_uri
    )
      throw new Error('Intake unavailable');
    const bytes = await this.options.assets.store.read(asset);
    if (
      bytes.length !== Number(e.byte_length) ||
      bytesHash(bytes) !== e.content_hash
    )
      throw new Error('Intake integrity');
    await this.item(itemId, 'read');
    return bytes;
  }
  /** Append an immutable input revision. Reprocessing never creates actions. */
  async analyze(
    itemId: string,
    configuration: Record<string, unknown>,
    requestKey: string,
  ): Promise<{ id: string; revision: number }> {
    const frozen = structuredClone(configuration);
    if (
      Object.hasOwn(frozen, 'humanCorrection') &&
      frozen.stage !== 'interpret'
    )
      throw new Error('Human corrections require authenticated split revision');
    return this.tx((db) => this.appendAnalysis(db, itemId, frozen, requestKey));
  }
  private async appendAnalysis(
    db: DatabaseInterface,
    itemId: string,
    configuration: Record<string, unknown>,
    requestKey: string,
  ): Promise<{ id: string; revision: number }> {
    nonempty(requestKey);
    const configDigest = digest(configuration);
    await this.lock(db, itemId);
    const item = await this.item(itemId, 'process', db);
    if (item.receipt_state !== 'ready' || item.cancelled)
      throw new Error('Intake not processable');
    const previous = await this.rows(db, 'intake_analyses', 'item_id=?', [
      itemId,
    ]);
    const replay = previous.find(
      (a) => object(a.data).requestKey === requestKey,
    );
    if (replay) {
      if (object(replay.data).configDigest !== configDigest)
        throw new Error('Analysis request conflict');
      return { id: String(replay.id), revision: Number(replay.revision) };
    }
    const evidence = await this.rows(
      db,
      'intake_evidence',
      "item_id=? AND state='durable'",
      [itemId],
    );
    await db.query(
      "UPDATE intake_analysis_attempts SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
    );
    await db.query(
      "UPDATE intake_analyses SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
    );
    const revision = Number(item.analysis_revision) + 1;
    await db.query(
      "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND revision<? AND state<>'completed'",
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
      revision,
    );
    const inputs = evidence
      .map((e) => ({ id: e.id, hash: e.content_hash }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const [analysis] = await this.insert(db, 'intake_analyses', {
      item_id: itemId,
      revision,
      fence: 0,
      attempt_number: 0,
      current_attempt_id: null,
      state: 'queued',
      input_digest: digest({ inputs, configuration }),
      data: canonical({ inputs, configuration, requestKey, configDigest }),
    });
    await db.query(
      "UPDATE intake_items SET analysis_revision=?,processing_state='queued' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
      revision,
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
    );
    await this.insert(
      db,
      'intake_dispatches',
      {
        item_id: itemId,
        stage: 'analyze',
        revision,
        state: 'pending',
        job_id: '',
        deliveries: 0,
        data: '{}',
      },
      'tenant_id,item_id,stage,revision',
    );
    return { id: String(analysis.id), revision };
  }

  /** Record an authenticated split correction and queue fresh extraction, never copy model output. */
  async reviseLogicalSplit(
    input: LogicalSplitInput,
  ): Promise<{ id: string; revision: number }> {
    const frozen = structuredClone(input);
    nonempty(frozen.requestId);
    integer(frozen.expectedRevision);
    if (
      !Array.isArray(frozen.groups) ||
      !frozen.groups.length ||
      frozen.groups.length > 100 ||
      frozen.groups.some(
        (group) =>
          !Array.isArray(group) ||
          !group.length ||
          group.length > 1000 ||
          group.some((page) => !Number.isSafeInteger(page) || page < 1),
      )
    )
      throw new Error('Invalid logical split');
    const pages = frozen.groups.flat();
    if (pages.length > 1000 || new Set(pages).size !== pages.length)
      throw new Error('Invalid logical split');
    const requestKey = `split:${frozen.requestId}`;
    const correction = {
      ...frozen,
      actorId: this.scope.actorId,
      kind: 'logical_split',
    };
    const replay = await this.tx(async (db) => {
      await this.lock(db, frozen.itemId);
      await this.item(frozen.itemId, 'process', db);
      const found = (
        await this.rows(db, 'intake_analyses', 'item_id=?', [frozen.itemId])
      ).find((row) => object(row.data).requestKey === requestKey);
      if (!found) return null;
      if (
        digest(object(object(found.data).configuration).humanCorrection) !==
        digest(correction)
      )
        throw new Error('Split request conflict');
      return { id: String(found.id), revision: Number(found.revision) };
    });
    if (replay) {
      // Idempotency acknowledges only an intent the current reviewer may still access.
      await (await this.proposals())[generationSnapshotRead](
        frozen.itemId,
        (work) => this.tx(work),
        (db) =>
          this.completedAnalysisSnapshot(
            db,
            frozen.itemId,
            frozen.attemptId,
            false,
          ),
        undefined,
        true,
      );
      return replay;
    }
    let result: { id: string; revision: number } | undefined;
    await (await this.proposals())[generationSnapshotRead](
      frozen.itemId,
      (work) => this.tx(work),
      (db) =>
        this.completedAnalysisSnapshot(
          db,
          frozen.itemId,
          frozen.attemptId,
          true,
        ),
      async (db, current) => {
        if (current.revision !== frozen.expectedRevision)
          throw new Error('Stale logical split');
        const pin = object(object(current.configuration.proposals).source);
        const source = await this.completedAnalysisSnapshot(
          db,
          frozen.itemId,
          String(pin.attemptId),
          false,
        );
        for (const key of [
          'attemptId',
          'revision',
          'inputDigest',
          'outputDigest',
          'evidenceDigest',
        ] as const)
          if (pin[key] !== source[key]) throw new Error('Split source changed');
        const extraction = source.result.output.results;
        if (!Array.isArray(extraction))
          throw new Error('Split source unavailable');
        const evidence = extraction.find(
          (value) => object(object(value).evidence).id === frozen.evidenceId,
        );
        if (!evidence) throw new Error('Split evidence unavailable');
        const observed = new Set<number>();
        for (const value of object(evidence).segments as unknown[]) {
          const location = object(object(value).location);
          if (location.kind === 'page') observed.add(Number(location.page));
          if (location.kind === 'pages') {
            const from = Number(location.startPage),
              to = Number(location.endPage);
            if (
              !Number.isSafeInteger(from) ||
              !Number.isSafeInteger(to) ||
              to - from > 1000
            )
              throw new Error('Invalid source range');
            for (let page = from; page <= to; page++) observed.add(page);
          }
        }
        if (
          !observed.size ||
          pages.length !== observed.size ||
          pages.some((page) => !observed.has(page))
        )
          throw new Error('Split must cover observed pages exactly');
        // Re-extraction retains the supported immediate-predecessor interpretation pin.
        result = await this.appendAnalysis(
          db,
          frozen.itemId,
          { ...source.configuration, humanCorrection: correction },
          requestKey,
        );
      },
      true,
    );
    if (!result) throw new Error('Split unavailable');
    return result;
  }
  /** Allocate a fenced attempt; active leases cannot be stolen before expiry. */
  async claimAnalysis(
    itemId: string,
    revision: number,
    workerId: string,
  ): Promise<AnalysisLease | null> {
    integer(revision);
    nonempty(workerId);
    return this.tx(async (db) => {
      await this.lock(db, itemId);
      const item = await this.item(itemId, 'process', db);
      if (
        item.cancelled ||
        item.receipt_state !== 'ready' ||
        Number(item.analysis_revision) !== revision
      )
        return null;
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'item_id=? AND revision=?',
        [itemId, revision],
      );
      if (
        !analysis ||
        ['completed', 'partial'].includes(String(analysis.state))
      )
        return null;
      const limits = object(
        object(item.data).limits,
      ) as unknown as IntakeLimits;
      const attempts = await this.rows(
        db,
        'intake_analysis_attempts',
        'analysis_id=?',
        [analysis.id],
      );
      const prior = attempts.find((a) => a.id === analysis.current_attempt_id);
      if (
        prior?.state === 'running' &&
        persistedDate(prior.lease_until) > this.now()
      )
        return null;
      if (Number(analysis.attempt_number) >= limits.maxAttempts) {
        if (prior?.state === 'running')
          await db.query(
            "UPDATE intake_analysis_attempts SET state='needs_attention',safe_error='limit' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            prior.id,
          );
        await db.query(
          "UPDATE intake_analyses SET state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          analysis.id,
        );
        await db.query(
          "UPDATE intake_items SET processing_state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND analysis_revision=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          revision,
        );
        await db.query(
          "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND revision=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          revision,
        );
        return null;
      }
      if (prior && ['running', 'queued'].includes(String(prior.state)))
        await db.query(
          "UPDATE intake_analysis_attempts SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          prior.id,
        );
      const fence = Number(analysis.fence) + 1;
      const attempt = Number(analysis.attempt_number) + 1;
      const token = randomUUID();
      const [row] = await this.insert(db, 'intake_analysis_attempts', {
        item_id: itemId,
        analysis_id: analysis.id,
        attempt_number: attempt,
        fence,
        state: 'running',
        lease_token: token,
        lease_until: new Date(
          this.now().getTime() + limits.leaseMs,
        ).toISOString(),
        output_digest: '',
        safe_error: '',
        confidence: null,
        data: canonical({
          workerId,
          startedAt: this.now().toISOString(),
          limits,
        }),
      });
      await db.query(
        "UPDATE intake_analyses SET fence=?,attempt_number=?,current_attempt_id=?,state='running' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        fence,
        attempt,
        row.id,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        analysis.id,
      );
      await db.query(
        "UPDATE intake_items SET processing_state='running' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      return {
        itemId,
        analysisId: String(analysis.id),
        attemptId: String(row.id),
        revision,
        fence,
        token,
      };
    });
  }
  private async completedAnalysisSnapshot(
    db: DatabaseInterface,
    itemId: string,
    attemptId: string | undefined,
    current: boolean,
  ): Promise<CompletedAnalysisSnapshot> {
    await this.lock(db, itemId);
    const item = await this.item(itemId, 'process', db);
    if (item.cancelled) throw new Error('Analysis unavailable');
    if (attemptId === undefined) {
      if (!current) throw new Error('Historical attempt required');
      const [latest] = await this.rows(
        db,
        'intake_analyses',
        'item_id=? AND revision=?',
        [itemId, item.analysis_revision],
      );
      if (!latest?.current_attempt_id) throw new Error('Analysis unavailable');
      attemptId = String(latest.current_attempt_id);
    }

    const [attempt] = await this.rows(
      db,
      'intake_analysis_attempts',
      'item_id=? AND id=?',
      [itemId, attemptId],
    );
    if (
      !attempt ||
      !['completed', 'partial'].includes(String(attempt.state)) ||
      !attempt.output_digest
    )
      throw new Error('Analysis unavailable');
    const [analysis] = await this.rows(
      db,
      'intake_analyses',
      'item_id=? AND id=?',
      [itemId, attempt.analysis_id],
    );
    if (
      !analysis ||
      analysis.current_attempt_id !== attemptId ||
      (current && Number(item.analysis_revision) !== Number(analysis.revision))
    )
      throw new Error('Analysis unavailable');
    const data = object(analysis.data);
    const configuration = object(data.configuration);
    if (
      !Array.isArray(data.inputs) ||
      !data.inputs.length ||
      digest({ inputs: data.inputs, configuration }) !==
        analysis.input_digest ||
      digest(configuration) !== data.configDigest
    )
      throw new Error('Analysis input integrity');
    const resultData = object(attempt.data);
    const result = {
      status: resultData.status,
      provider: resultData.provider,
      model: resultData.model,
      version: resultData.version,
      output: resultData.output,
      usage: resultData.usage,
      ...(Object.hasOwn(resultData, 'error')
        ? { error: resultData.error }
        : {}),
      ...(Object.hasOwn(resultData, 'confidence')
        ? { confidence: resultData.confidence }
        : {}),
    } as AnalysisOutput;
    if (
      result.status !== attempt.state ||
      digest(result) !== attempt.output_digest
    )
      throw new Error('Analysis output integrity');
    const evidence: IntakeEvidenceDTO[] = [];
    for (const input of data.inputs) {
      const frozen = object(input);
      const [row] = await this.rows(
        db,
        'intake_evidence',
        "item_id=? AND id=? AND state='durable'",
        [itemId, frozen.id],
      );
      if (!row || row.content_hash !== frozen.hash)
        throw new Error('Analysis input integrity');
      evidence.push({
        id: String(row.id),
        partId: String(row.part_id),
        parentEvidenceId: row.parent_evidence_id
          ? String(row.parent_evidence_id)
          : null,
        mediaType: String(row.media_type),
        contentHash: String(row.content_hash),
        byteLength: Number(row.byte_length),
      });
    }
    if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length)
      throw new Error('Analysis input integrity');
    await this.item(itemId, 'process', db);
    return structuredClone({
      itemId,
      attemptId,
      revision: Number(analysis.revision),
      inputDigest: String(analysis.input_digest),
      outputDigest: String(attempt.output_digest),
      evidenceDigest: digest(data.inputs),
      configuration,
      evidence,
      result,
    });
  }
  /** Detached successful current revision; always current-scope/process authorized. */
  async getCompletedAnalysis(
    itemId: string,
    attemptId?: string,
  ): Promise<CompletedAnalysisSnapshot> {
    const snapshot = await this.tx((db) =>
      this.completedAnalysisSnapshot(db, itemId, attemptId, true),
    );
    await this.point('analysis:snapshot-read');
    const read = async (db: DatabaseInterface) => {
      const current = await this.completedAnalysisSnapshot(
        db,
        itemId,
        snapshot.attemptId,
        true,
      );
      if (
        current.inputDigest !== snapshot.inputDigest ||
        current.outputDigest !== snapshot.outputDigest
      )
        throw new Error('Analysis changed');
      return current;
    };
    if (snapshot.configuration.stage === 'interpret')
      return (await this.proposals())[generationSnapshotRead](
        itemId,
        (work) => this.tx(work),
        read,
      );
    return this.tx(read);
  }
  /** Historical source is readable only through its frozen pin on a live generation lease. */
  async getGenerationInput(lease: AnalysisLease) {
    const generation = await this.getAnalysisInput(lease);
    const configuration = generation.configuration;
    const pin = object(object(configuration.proposals).source);
    if (
      configuration.stage !== 'interpret' ||
      typeof pin.attemptId !== 'string'
    )
      throw new Error('Invalid generation source');
    const source = await this.tx((db) =>
      this.completedAnalysisSnapshot(
        db,
        lease.itemId,
        String(pin.attemptId),
        false,
      ),
    );
    for (const key of [
      'attemptId',
      'revision',
      'inputDigest',
      'outputDigest',
      'evidenceDigest',
    ] as const)
      if (pin[key] !== source[key])
        throw new Error('Generation source changed');
    if (
      source.result.provider !== 'smrt-ingestion-extraction' ||
      source.configuration.stage === 'interpret' ||
      source.revision !== generation.revision - 1 ||
      digest(configuration.humanCorrection ?? null) !==
        digest(source.configuration.humanCorrection ?? null) ||
      digest(
        generation.evidence.map((entry) => ({
          id: entry.id,
          hash: entry.contentHash,
        })),
      ) !== source.evidenceDigest
    )
      throw new Error('Generation evidence changed');
    await this.getAnalysisInput(lease);
    return { generation, source };
  }
  /** Reload immutable inputs only through the current live processing lease. */
  async getAnalysisInput(lease: AnalysisLease): Promise<{
    revision: number;
    attemptId: string;
    fence: number;
    inputDigest: string;
    maxOutputBytes: number;
    configuration: Record<string, unknown>;
    evidence: IntakeEvidenceDTO[];
  }> {
    return this.tx(async (db) => {
      await this.lock(db, lease.itemId);
      const item = await this.item(lease.itemId, 'process', db);
      if (item.cancelled || Number(item.analysis_revision) !== lease.revision)
        throw new Error('Analysis lease unavailable');
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'id=? AND item_id=?',
        [lease.analysisId, lease.itemId],
      );
      const [attempt] = await this.rows(
        db,
        'intake_analysis_attempts',
        'id=? AND analysis_id=? AND item_id=?',
        [lease.attemptId, lease.analysisId, lease.itemId],
      );
      if (
        !analysis ||
        !attempt ||
        Number(analysis.revision) !== lease.revision ||
        analysis.current_attempt_id !== lease.attemptId ||
        Number(analysis.fence) !== lease.fence ||
        Number(attempt.fence) !== lease.fence ||
        attempt.state !== 'running' ||
        attempt.lease_token !== lease.token ||
        persistedDate(attempt.lease_until) <= this.now()
      )
        throw new Error('Analysis lease unavailable');
      const data = object(analysis.data);
      const configuration = object(data.configuration);
      if (
        !Array.isArray(data.inputs) ||
        !data.inputs.length ||
        digest({ inputs: data.inputs, configuration }) !==
          analysis.input_digest ||
        digest(configuration) !== data.configDigest
      )
        throw new Error('Analysis input integrity');
      const evidence: IntakeEvidenceDTO[] = [];
      for (const input of data.inputs) {
        const frozen = object(input);
        const [row] = await this.rows(
          db,
          'intake_evidence',
          "item_id=? AND id=? AND state='durable'",
          [lease.itemId, frozen.id],
        );
        if (!row || row.content_hash !== frozen.hash)
          throw new Error('Analysis input integrity');
        evidence.push({
          id: String(row.id),
          partId: String(row.part_id),
          parentEvidenceId: row.parent_evidence_id
            ? String(row.parent_evidence_id)
            : null,
          mediaType: String(row.media_type),
          contentHash: String(row.content_hash),
          byteLength: Number(row.byte_length),
        });
      }
      if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length)
        throw new Error('Analysis input integrity');
      return {
        revision: lease.revision,
        attemptId: lease.attemptId,
        fence: lease.fence,
        inputDigest: String(analysis.input_digest),
        maxOutputBytes: Number(object(object(item.data).limits).maxOutputBytes),
        configuration,
        evidence,
      };
    });
  }
  /** Publish once, only through the current unexpired fence and captured scope. */
  async completeAnalysis(
    lease: AnalysisLease,
    output: AnalysisOutput,
  ): Promise<boolean> {
    if (
      !['completed', 'partial', 'failed', 'needs_attention'].includes(
        output.status,
      ) ||
      !output.provider ||
      !output.model ||
      !output.version ||
      (output.error && !failures.has(output.error))
    )
      throw new Error('Invalid analysis output');
    if (
      output.confidence !== undefined &&
      (!Number.isFinite(output.confidence) ||
        output.confidence < 0 ||
        output.confidence > 1)
    )
      throw new Error('Invalid confidence');
    for (const value of Object.values(output.usage))
      if (!Number.isFinite(value) || value < 0)
        throw new Error('Invalid usage');
    const serialized = canonical(output);
    const outputDigest = digest(output);
    return this.tx(async (db) => {
      await this.lock(db, lease.itemId);
      const item = await this.item(lease.itemId, 'process', db);
      if (item.cancelled || Number(item.analysis_revision) !== lease.revision)
        return false;
      const limits = object(
        object(item.data).limits,
      ) as unknown as IntakeLimits;
      if (Buffer.byteLength(serialized) > limits.maxOutputBytes)
        throw new Error('Analysis output budget exceeded');
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'id=? AND item_id=?',
        [lease.analysisId, lease.itemId],
      );
      if (
        !analysis ||
        analysis.current_attempt_id !== lease.attemptId ||
        Number(analysis.fence) !== lease.fence
      )
        return false;
      const [attempt] = await this.rows(
        db,
        'intake_analysis_attempts',
        'id=? AND analysis_id=?',
        [lease.attemptId, lease.analysisId],
      );
      if (
        !attempt ||
        attempt.state !== 'running' ||
        attempt.lease_token !== lease.token ||
        persistedDate(attempt.lease_until) <= this.now()
      )
        return false;
      const attemptData = {
        ...object(attempt.data),
        ...output,
        completedAt: this.now().toISOString(),
      };
      await db.query(
        'UPDATE intake_analysis_attempts SET state=?,output_digest=?,safe_error=?,confidence=?,data=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        output.status,
        outputDigest,
        output.error ?? '',
        output.confidence ?? null,
        canonical(attemptData),
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.attemptId,
      );
      await db.query(
        'UPDATE intake_analyses SET state=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        output.status,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.analysisId,
      );
      await db.query(
        'UPDATE intake_items SET processing_state=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        output.status,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.itemId,
      );
      if (['completed', 'partial', 'needs_attention'].includes(output.status))
        await db.query(
          "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND revision=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          lease.itemId,
          lease.revision,
        );
      return true;
    });
  }
  /** Terminal failure accounting without a provider payload. The fixed safe error
   * and lifecycle metadata are not charged to the provider-output byte ceiling. */
  async failAnalysis(
    lease: AnalysisLease,
    category: IntakeFailure,
  ): Promise<boolean> {
    if (!failures.has(category)) throw new Error('Invalid analysis failure');
    return this.tx(async (db) => {
      await this.lock(db, lease.itemId);
      const item = await this.item(lease.itemId, 'process', db);
      if (item.cancelled || Number(item.analysis_revision) !== lease.revision)
        return false;
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'id=? AND item_id=?',
        [lease.analysisId, lease.itemId],
      );
      const [attempt] = await this.rows(
        db,
        'intake_analysis_attempts',
        'id=? AND analysis_id=? AND item_id=?',
        [lease.attemptId, lease.analysisId, lease.itemId],
      );
      if (
        !analysis ||
        !attempt ||
        Number(analysis.revision) !== lease.revision ||
        analysis.current_attempt_id !== lease.attemptId ||
        Number(analysis.fence) !== lease.fence ||
        Number(attempt.fence) !== lease.fence ||
        attempt.state !== 'running' ||
        attempt.lease_token !== lease.token ||
        persistedDate(attempt.lease_until) <= this.now()
      )
        return false;
      await db.query(
        "UPDATE intake_analysis_attempts SET state='needs_attention',safe_error=?,data=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        category,
        canonical({
          ...object(attempt.data),
          completedAt: this.now().toISOString(),
        }),
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.attemptId,
      );
      await db.query(
        "UPDATE intake_analyses SET state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.analysisId,
      );
      await db.query(
        "UPDATE intake_items SET processing_state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.itemId,
      );
      await db.query(
        "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND revision=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.itemId,
        lease.revision,
      );
      return true;
    });
  }
  /** Cancel pending processing immediately; original receipt remains ready. */
  async cancel(itemId: string): Promise<void> {
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      await this.item(itemId, 'process', db);
      await db.query(
        "UPDATE intake_items SET cancelled=?,processing_state='cancelled' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        true,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_analyses SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_analysis_attempts SET state='superseded',safe_error='cancelled' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
    });
  }
  /** Mint an action only on an explicit host intention, never during reanalysis. */
  async createAction(
    itemId: string,
    actionKey: string,
    provenance: Record<string, unknown>,
  ): Promise<string> {
    nonempty(actionKey);
    const payload = canonical(provenance);
    return this.tx(async (db) => {
      await this.lock(db, itemId);
      const item = await this.item(itemId, 'process', db);
      if (item.cancelled) throw new Error('Intake cancelled');
      const [existing] = await this.rows(
        db,
        'intake_actions',
        'item_id=? AND action_key=?',
        [itemId, actionKey],
      );
      if (existing) {
        if (canonical(object(existing.data)) !== payload)
          throw new Error('Action identity conflict');
        return String(existing.id);
      }
      const [action] = await this.insert(db, 'intake_actions', {
        item_id: itemId,
        action_key: actionKey,
        state: 'proposed',
        proposal_revision: 0,
        review_version: 0,
        execution_attempt: 0,
        fence: 0,
        result_digest: '',
        data: payload,
      });
      return String(action.id);
    });
  }
  /** Append a proposal pinned to a completed attempt. Policy/preview is host-owned. */
  async publishProposal(input: {
    itemId: string;
    actionId: string;
    attemptId: string;
    expectedRevision: number;
    binding: Record<string, unknown>;
  }): Promise<{ id: string; revision: number; bindingHash: string }> {
    canonical(input.binding);
    return this.tx(async (db) => {
      await this.lock(db, input.itemId);
      const item = await this.item(input.itemId, 'process', db);
      if (item.cancelled) throw new Error('Intake cancelled');
      const [action] = await this.rows(
        db,
        'intake_actions',
        'item_id=? AND id=?',
        [input.itemId, input.actionId],
      );
      const [attempt] = await this.rows(
        db,
        'intake_analysis_attempts',
        'item_id=? AND id=?',
        [input.itemId, input.attemptId],
      );
      if (
        !action ||
        !attempt ||
        !['completed', 'partial'].includes(String(attempt.state)) ||
        !attempt.output_digest
      )
        throw new Error('Invalid proposal evidence');
      if (
        Number(action.proposal_revision) !== input.expectedRevision ||
        ['succeeded', 'executing', 'outcome_unknown'].includes(
          String(action.state),
        )
      )
        throw new Error('Proposal conflict');
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
        throw new Error('Proposal conflict');
      const bindingHash = digest({
        binding: input.binding,
        attemptId: attempt.id,
        attemptDigest: attempt.output_digest,
        inputDigest: analysis.input_digest,
      });
      const revision = input.expectedRevision + 1;
      const [proposal] = await this.insert(db, 'intake_proposals', {
        item_id: input.itemId,
        action_id: input.actionId,
        analysis_id: attempt.analysis_id,
        analysis_attempt_id: attempt.id,
        revision,
        binding_hash: bindingHash,
        data: canonical({
          binding: input.binding,
          attemptDigest: attempt.output_digest,
        }),
      });
      await db.query(
        "UPDATE intake_actions SET proposal_revision=?,state='waiting_review',review_version=review_version+1 WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        revision,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        input.actionId,
      );
      return { id: String(proposal.id), revision, bindingHash };
    });
  }
  /** Persist frozen plan structure; no expansion or apply authority is implied. */
  async appendPlan(
    itemId: string,
    planKey: string,
    revision: number,
    steps: Array<{ actionId: string; proposalRevision: number }>,
    definition: Record<string, unknown>,
  ): Promise<string> {
    nonempty(planKey);
    integer(revision);
    return this.tx(async (db) => {
      await this.lock(db, itemId);
      await this.item(itemId, 'process', db);
      if (
        !steps.length ||
        new Set(steps.map((s) => s.actionId)).size !== steps.length
      )
        throw new Error('Invalid plan');
      for (const step of steps) {
        const [proposal] = await this.rows(
          db,
          'intake_proposals',
          'item_id=? AND action_id=? AND revision=?',
          [itemId, step.actionId, step.proposalRevision],
        );
        if (!proposal) throw new Error('Invalid plan binding');
      }
      const data = canonical({ steps, definition });
      const hash = digest({ steps, definition });
      const previous = await this.rows(
        db,
        'intake_plans',
        'item_id=? AND plan_key=?',
        [itemId, planKey],
      );
      const replay = previous.find((p) => Number(p.revision) === revision);
      if (replay) {
        if (replay.digest !== hash) throw new Error('Plan conflict');
        return String(replay.id);
      }
      if (
        revision !==
        Math.max(0, ...previous.map((p) => Number(p.revision))) + 1
      )
        throw new Error('Plan revision conflict');
      const [plan] = await this.insert(db, 'intake_plans', {
        item_id: itemId,
        plan_key: planKey,
        revision,
        digest: hash,
        data,
      });
      return String(plan.id);
    });
  }
  /** Revoke immediately and durably schedule deletion before external I/O. */
  async expire(itemId: string): Promise<void> {
    await this.scheduleExpiry(itemId);
    await this.repairDeletions();
  }
  private async scheduleExpiry(itemId: string): Promise<void> {
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      await this.item(itemId, 'delete', db, true);
      await db.query(
        "UPDATE intake_items SET visibility='expired',processing_state='expired',cancelled=?,lease_token='',lease_until=NULL WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        true,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_evidence SET state='revoked' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_analyses SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_analysis_attempts SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      const originals = await this.rows(db, 'intake_evidence', 'item_id=?', [
        itemId,
      ]);
      const cleanup = originals
        .filter((e) => e.asset_id && e.source_uri)
        .map((e) => ({ assetId: e.asset_id, sourceUri: e.source_uri }));
      await this.insert(
        db,
        'intake_deletions',
        { item_id: itemId, state: 'pending', data: canonical({ cleanup }) },
        'tenant_id,item_id',
      );
    });
  }
  /** Retry privacy propagation. Minimal receipt/action identities remain replay-safe. */
  async repairDeletions(): Promise<number> {
    let completed = 0;
    const pending = await this.rows(this.db, 'intake_deletions');
    for (const intent of pending) {
      const itemId = String(intent.item_id);
      await this.item(itemId, 'delete', this.db, true);
      const evidence = await this.rows(
        this.db,
        'intake_evidence',
        'item_id=?',
        [itemId],
      );
      for (const row of evidence) {
        if (!row.asset_id) continue;
        const asset = await withTenant({ tenantId: this.scope.tenantId }, () =>
          this.options.assets.collection.get({ id: String(row.asset_id) }),
        );
        if (asset) {
          if (asset.tenantId !== this.scope.tenantId)
            throw new Error('Asset unavailable');
          await this.options.assets.store.remove(asset);
        }
      }
      // Retain cleanup locators after revocation: a killed stale writer may finish
      // storage I/O after owner deletion. Repeated sweeps remove those bytes too.
      const cleanup = object(intent.data).cleanup;
      if (Array.isArray(cleanup))
        for (const entry of cleanup) {
          const locator = object(entry);
          const asset = new Asset({ db: this.db });
          asset.id = String(locator.assetId);
          asset.tenantId = this.scope.tenantId;
          asset.sourceUri = String(locator.sourceUri);
          // Remove the object directly through the public store, even when its
          // database record has already been pruned.
          await this.options.assets.store.removeFile(asset);
        }
      if (intent.state === 'completed') continue;
      await this.options.purgeDerived({
        tenantId: this.scope.tenantId,
        itemId,
      });
      await this.point('deleted');
      await this.tx(async (db) => {
        await this.lock(db, itemId);
        const item = await this.item(itemId, 'delete', db, true);
        for (const table of TABLES.filter(
          (t) => t !== 'intake_items' && t !== 'intake_deletions',
        ))
          await db.query(
            `UPDATE ${table} SET data='{}' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?`,
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            itemId,
          );
        await db.query(
          "UPDATE intake_evidence SET source_uri='',content_hash='',media_type='',byte_length=0 WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
        );
        await db.query(
          "UPDATE intake_items SET data=?,trace_id='' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
          canonical({
            capturedCeiling: object(item.data).capturedCeiling ?? {},
          }),
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
        );
        await db.query(
          "UPDATE intake_deletions SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          intent.id,
        );
      });
      completed++;
    }
    return completed;
  }
  /** Run host-configured expiry policy and retry interrupted deletion propagation. */
  async sweepRetention(): Promise<number> {
    const expired = await this.rows(
      this.db,
      'intake_items',
      "visibility='active' AND expires_at<=?",
      [this.now().toISOString()],
    );
    try {
      for (const item of expired) await this.scheduleExpiry(String(item.id));
    } catch (error) {
      // A later denial must not strand already committed deletion intents.
      // Preserve the scheduling failure even if cleanup also needs a retry.
      try {
        await this.repairDeletions();
      } catch {
        // Durable intents remain available to the next authorized repair.
      }
      throw error;
    }
    await this.repairDeletions();
    return expired.length;
  }
}

export * from './extraction.js';
export * from './sources/index.js';

/**
 * LotService — the only sanctioned way to create and change lots.
 *
 * A lot is an identity for traceable stock: a batch code, a supplier lot, a
 * serial number. This service records lots as they arrive, links them to
 * what consumed them, keeps documents (certificates, reports) attached, and
 * answers "where did this come from, and where did it go". Every
 * after-the-fact change is a {@link LotCorrection} with a mandatory reason,
 * so a wrong number or a wrong link is fixed on the record, not erased.
 *
 * **Stock is separate.** Receiving a lot creates the identity only; it moves
 * no quantity. Compose the two in one transaction so the lot and its stock
 * land together or not at all:
 *
 * ```typescript
 * await stock.withTransaction(async (tx) => {
 *   const lots = await createLotService({ db: tx.db });
 *   const lot = await lots.receiveLot({ lotNumber: 'B-1042', skuId });
 *   await tx.receive(skuId, locationId, 40, { lotId: lot.id });
 * });
 * ```
 *
 * **Authorization is the caller's.** Nothing here checks who may receive,
 * correct or unlink; pass `actorProfileId` so the trail says who did.
 *
 * **Concurrency.** Changes that matter to a lot (usage, unlink, number,
 * attribute and status corrections) `save()` the lot row, so two concurrent
 * changes to one lot conflict on its revision and the loser's transaction
 * rolls back; retry it.
 *
 * @packageDocumentation
 */

import {
  type DatabaseConfig,
  isUniqueViolationError,
  resolveDatabase,
} from '@happyvertical/smrt-core';
import {
  LotCollection,
  LotCorrectionCollection,
  LotDocumentCollection,
  LotUsageCollection,
  lotSearchKey,
  StockMovementCollection,
} from '../collections/index.js';
import type { Lot } from '../models/Lot.js';
import type { LotCorrection } from '../models/LotCorrection.js';
import type { LotDocument } from '../models/LotDocument.js';
import type { LotUsage } from '../models/LotUsage.js';
import type { StockMovement } from '../models/StockMovement.js';
import type { LotCorrectionKind, LotKind } from '../types.js';
import {
  DuplicateLotError,
  LotCorrectionError,
  LotInUseError,
  LotNotFoundError,
} from './lot-errors.js';

const MAX_LOT_NUMBER = 128;
const MAX_IDENTITY_KEY = 160;
const MAX_REASON = 1000;
const DEFAULT_TRACE_DEPTH = 10;

/** Options accepted by the {@link LotService} factory. */
export interface LotServiceOptions {
  /** Same shapes as {@link StockServiceOptions.db}; pass `tx.db` to join a transaction. */
  db: DatabaseConfig;
}

/** Input to {@link LotService.receiveLot}. */
export interface ReceiveLotInput {
  /** Batch code, supplier lot or serial number as the caller has it. */
  lotNumber: string;
  /** Catalog Sku the lot is of; omit for uncatalogued material. */
  skuId?: string | null;
  /** `lot` (default) or `serial`. A serial is always unique with quantity 1. */
  kind?: LotKind;
  /**
   * Make the number unique per SKU: a second receipt of the same number
   * throws {@link DuplicateLotError}. Default false for lots, always true
   * for serials. Without it one supplier lot may be received more than once.
   */
  unique?: boolean;
  /**
   * Makes the receipt retry-safe: repeating a call with the same key
   * returns the lot the first call made instead of creating another.
   * Ignored for unique lots and serials, whose number is the identity.
   */
  idempotencyKey?: string;
  receivedQty?: number;
  unit?: string;
  sourceType?: string;
  sourceId?: string;
  attributes?: Record<string, unknown>;
  /** Default `active`. */
  status?: string;
  receivedAt?: Date;
  actorProfileId?: string | null;
}

/** Who made a correction, and why. `reason` is required. */
export interface LotChangeOptions {
  reason: string;
  actorProfileId?: string | null;
}

/** Input to {@link LotService.recordUsage}. */
export interface RecordUsageInput {
  /** What used the lot, e.g. `'ProductionOrder'`; `'Lot'` for an assembly. */
  consumerType: string;
  consumerId: string;
  /** Quantity used; omit when unspecified or the whole lot. */
  qty?: number | null;
  unit?: string;
  /**
   * Refuse when a different consumer already has an active usage
   * ({@link LotInUseError}). Default true for serials, false for lots.
   */
  exclusive?: boolean;
  /** Optional StockMovement that took the quantity out. */
  movementId?: string | null;
  actorProfileId?: string | null;
}

/** Input to {@link LotService.attachDocument}. */
export interface AttachDocumentInput {
  /** Id of the stored file (an Asset from `@happyvertical/smrt-assets`). */
  assetId: string;
  /** Default `certificate`. */
  role?: string;
  actorProfileId?: string | null;
}

/** Options for {@link LotService.traceForward} and {@link LotService.traceBack}. */
export interface TraceOptions {
  /** Include usages that were unlinked, and detached documents. Default false. */
  includeUnlinked?: boolean;
  /** How many levels of assembly to follow. Default 10. */
  depth?: number;
}

/**
 * One lot in a trace.
 *
 * In {@link LotService.traceForward}, `usages` are every use of `lot` and
 * `children` are the lots that consumed it (consumer type `Lot`). In
 * {@link LotService.traceBack}, `usages` are the edges from the queried
 * consumer to `lot` and `children` are the lots that went into `lot`.
 */
export interface TraceNode {
  lot: Lot;
  usages: LotUsage[];
  /** Stock movements that carried this lot, oldest first. */
  movements: StockMovement[];
  documents: LotDocument[];
  children: TraceNode[];
}

let lastCorrectionMs = 0;

/**
 * A timestamp that never repeats within this process, so corrections made
 * in the same millisecond still sort in the order they were written.
 */
function nextCorrectionTime(): Date {
  lastCorrectionMs = Math.max(Date.now(), lastCorrectionMs + 1);
  return new Date(lastCorrectionMs);
}

function requireReason(reason: string | undefined): string {
  const text = (reason ?? '').trim();
  if (!text) throw new LotCorrectionError('A reason is required');
  if (text.length > MAX_REASON) {
    throw new LotCorrectionError(`Reason is over ${MAX_REASON} characters`);
  }
  return text;
}

function normalizeLotNumber(lotNumber: string | undefined): string {
  const text = (lotNumber ?? '').trim();
  if (!text) throw new Error('lotNumber is required');
  if (text.length > MAX_LOT_NUMBER) {
    throw new Error(`lotNumber is over ${MAX_LOT_NUMBER} characters`);
  }
  return text;
}

/** The database-enforced identity for a lot; see {@link Lot.identityKey}. */
function numberIdentity(
  kind: LotKind,
  skuId: string | null,
  searchKey: string,
): Promise<string> {
  return boundedIdentity(`u:${kind}:${skuId ?? ''}:${searchKey}`, 'uh:');
}

/**
 * Keep an identity within the column: one that is too long is replaced by a
 * SHA-256 digest. Web Crypto, not `node:crypto`, so the package root stays
 * importable in the browser.
 */
async function boundedIdentity(
  key: string,
  hashPrefix: string,
): Promise<string> {
  if (key.length <= MAX_IDENTITY_KEY) return key;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hashPrefix}${hex}`;
}

function jsonOrEmpty(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value);
}

export class LotService {
  private constructor(
    /** The database this service is bound to; `tx.db` inside {@link withTransaction}. */
    public readonly db: DatabaseConfig,
    public readonly lots: LotCollection,
    public readonly usages: LotUsageCollection,
    public readonly corrections: LotCorrectionCollection,
    public readonly documents: LotDocumentCollection,
    public readonly movements: StockMovementCollection,
    private readonly inTransaction: boolean = false,
  ) {}

  /** Internal factory — prefer {@link createLotService}. */
  static async create(options: LotServiceOptions): Promise<LotService> {
    // Resolve once so every collection shares one connection (see StockService.create).
    const resolved = await resolveDatabase(options.db);
    return new LotService(
      resolved as unknown as DatabaseConfig,
      await LotCollection.create({ db: resolved }),
      await LotUsageCollection.create({ db: resolved }),
      await LotCorrectionCollection.create({ db: resolved }),
      await LotDocumentCollection.create({ db: resolved }),
      await StockMovementCollection.create({ db: resolved }),
    );
  }

  /**
   * Run `work` in one database transaction with a tx-bound service. Nested
   * calls join the outer transaction. Same pattern as
   * {@link StockService.withTransaction}.
   */
  async withTransaction<T>(work: (tx: LotService) => Promise<T>): Promise<T> {
    if (this.inTransaction) return work(this);

    const underlying = (this.lots as unknown as { db?: unknown }).db as
      | { transaction?: (cb: (txDb: unknown) => Promise<T>) => Promise<T> }
      | undefined;
    if (typeof underlying?.transaction !== 'function') return work(this);

    return underlying.transaction(async (txDb) => {
      const db = txDb as DatabaseConfig;
      return work(
        new LotService(
          db,
          await LotCollection.create({ db }),
          await LotUsageCollection.create({ db }),
          await LotCorrectionCollection.create({ db }),
          await LotDocumentCollection.create({ db }),
          await StockMovementCollection.create({ db }),
          /* inTransaction */ true,
        ),
      );
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Receiving
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Record a lot or serial. Creates the identity only; it moves no stock
   * (see the module notes for composing with {@link StockService}).
   *
   * - Unique lots and all serials are keyed by SKU and number: receiving the
   *   same number again throws {@link DuplicateLotError}.
   * - Otherwise a repeated `idempotencyKey` returns the lot already made.
   * - With neither, every call makes a new lot, even for a number already
   *   seen: one supplier lot can arrive on two receipts.
   */
  async receiveLot(input: ReceiveLotInput): Promise<Lot> {
    const kind: LotKind = input.kind ?? 'lot';
    const lotNumber = normalizeLotNumber(input.lotNumber);
    const skuId = input.skuId ?? null;
    const unique = kind === 'serial' ? true : (input.unique ?? false);
    const searchKey = lotSearchKey(lotNumber);

    let identityKey: string;
    if (unique) identityKey = await numberIdentity(kind, skuId, searchKey);
    else if (input.idempotencyKey) {
      identityKey = await boundedIdentity(`k:${input.idempotencyKey}`, 'kh:');
    } else identityKey = `r:${globalThis.crypto.randomUUID()}`;

    // Look first: a unique violation aborts a Postgres transaction we may be
    // joined to, so the race below is the exception, not the normal path.
    const existing = await this.findByIdentity(identityKey);
    if (existing) return this.resolveExisting(existing, unique, lotNumber);

    try {
      return await this.lots.create({
        skuId,
        kind,
        lotNumber,
        searchKey,
        identityKey,
        uniqueNumber: unique,
        receivedQty: kind === 'serial' ? 1 : (input.receivedQty ?? 0),
        unit: input.unit ?? '',
        sourceType: input.sourceType ?? '',
        sourceId: input.sourceId ?? '',
        attributes: JSON.stringify(input.attributes ?? {}),
        status: input.status ?? 'active',
        receivedAt: input.receivedAt ?? new Date(),
        receivedByProfileId: input.actorProfileId ?? null,
        _insertOnly: true,
      });
    } catch (error) {
      if (!isUniqueViolationError(error)) throw error;
      const winner = await this.findByIdentity(identityKey);
      if (winner) return this.resolveExisting(winner, unique, lotNumber);
      throw error;
    }
  }

  private resolveExisting(existing: Lot, unique: boolean, lotNumber: string) {
    if (unique) throw new DuplicateLotError(lotNumber, existing.id ?? null);
    return existing;
  }

  private async findByIdentity(identityKey: string): Promise<Lot | null> {
    const rows = await this.lots.list({ where: { identityKey }, limit: 1 });
    return rows[0] ?? null;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Corrections
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Fix a mistyped lot number. Recomputes the lookup key and, for unique
   * lots and serials, the identity (a clash throws
   * {@link DuplicateLotError}). Refuses a change to the same number.
   */
  async correctLotNumber(
    lotId: string,
    lotNumber: string,
    options: LotChangeOptions,
  ): Promise<{ lot: Lot; correction: LotCorrection }> {
    const reason = requireReason(options.reason);
    const next = normalizeLotNumber(lotNumber);
    return this.atomically(async (tx) => {
      const lot = await tx.requireLot(lotId);
      if (next === lot.lotNumber) {
        throw new LotCorrectionError('The lot number is unchanged');
      }
      const previous = lot.lotNumber;
      lot.lotNumber = next;
      lot.searchKey = lotSearchKey(next);
      if (lot.uniqueNumber) {
        lot.identityKey = await numberIdentity(
          lot.kind,
          lot.skuId,
          lot.searchKey,
        );
        const clash = await tx.findByIdentity(lot.identityKey);
        if (clash && clash.id !== lot.id) {
          throw new DuplicateLotError(next, clash.id ?? null);
        }
      }
      try {
        await lot.save();
      } catch (error) {
        if (isUniqueViolationError(error)) {
          throw new DuplicateLotError(next, null);
        }
        throw error;
      }
      const correction = await tx.writeCorrection(lot, 'lot_number', reason, {
        oldValue: previous,
        newValue: next,
        actorProfileId: options.actorProfileId,
      });
      return { lot, correction };
    });
  }

  /**
   * Change attributes. Each key in `patch` is set to its value, or removed
   * when `null`. One correction is written per key that actually changes;
   * refuses when none does. Values are stored as JSON.
   */
  async correctAttributes(
    lotId: string,
    patch: Record<string, unknown | null>,
    options: LotChangeOptions,
  ): Promise<{ lot: Lot; corrections: LotCorrection[] }> {
    const reason = requireReason(options.reason);
    return this.atomically(async (tx) => {
      const lot = await tx.requireLot(lotId);
      const attributes = lot.getAttributes();
      const changes: Array<{ key: string; before: string; after: string }> = [];
      for (const [key, value] of Object.entries(patch)) {
        const before = jsonOrEmpty(attributes[key]);
        const after = value === null ? '' : jsonOrEmpty(value);
        if (before === after) continue;
        changes.push({ key, before, after });
        if (value === null) delete attributes[key];
        else attributes[key] = value;
      }
      if (changes.length === 0) {
        throw new LotCorrectionError('No attribute changes');
      }
      lot.setAttributes(attributes);
      await lot.save();
      const corrections: LotCorrection[] = [];
      for (const change of changes) {
        corrections.push(
          await tx.writeCorrection(lot, 'attribute', reason, {
            field: change.key,
            oldValue: change.before,
            newValue: change.after,
            actorProfileId: options.actorProfileId,
          }),
        );
      }
      return { lot, corrections };
    });
  }

  /** Change status (for example to `quarantined`). Refuses an unchanged status. */
  async setStatus(
    lotId: string,
    status: string,
    options: LotChangeOptions,
  ): Promise<{ lot: Lot; correction: LotCorrection }> {
    const reason = requireReason(options.reason);
    const next = status.trim();
    if (!next) throw new LotCorrectionError('A status is required');
    return this.atomically(async (tx) => {
      const lot = await tx.requireLot(lotId);
      if (lot.status === next) {
        throw new LotCorrectionError('The status is unchanged');
      }
      const previous = lot.status;
      lot.status = next;
      await lot.save();
      const correction = await tx.writeCorrection(lot, 'status', reason, {
        oldValue: previous,
        newValue: next,
        actorProfileId: options.actorProfileId,
      });
      return { lot, correction };
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Usage
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Record that a consumer used the lot. Repeating the call for the same
   * consumer returns the active usage already on record. For an exclusive
   * lot (serials by default) a second consumer throws
   * {@link LotInUseError}. The lot row is saved so two concurrent usages
   * conflict on its revision instead of both landing.
   */
  async recordUsage(lotId: string, input: RecordUsageInput): Promise<LotUsage> {
    const consumerType = (input.consumerType ?? '').trim();
    const consumerId = (input.consumerId ?? '').trim();
    if (!consumerType || !consumerId) {
      throw new Error('recordUsage: consumerType and consumerId are required');
    }
    if (consumerType === 'Lot' && consumerId === lotId) {
      throw new Error('recordUsage: a lot cannot be used by itself');
    }
    return this.atomically(async (tx) => {
      const lot = await tx.requireLot(lotId);
      const active = await tx.usages.findActiveForLot(lotId);
      const same = active.find(
        (usage) =>
          usage.consumerType === consumerType &&
          usage.consumerId === consumerId,
      );
      if (same) return same;
      const exclusive = input.exclusive ?? lot.kind === 'serial';
      const other = active[0];
      if (exclusive && other) {
        throw new LotInUseError(lotId, other.consumerType, other.consumerId);
      }
      const usage = await tx.usages.create({
        lotId,
        consumerType,
        consumerId,
        qty: input.qty ?? null,
        unit: input.unit ?? '',
        status: 'active',
        linkedAt: new Date(),
        linkedByProfileId: input.actorProfileId ?? null,
        movementId: input.movementId ?? null,
      });
      lot.lastUsedAt = new Date();
      await lot.save();
      return usage;
    });
  }

  /**
   * Remove a mistaken usage. The row stays, marked `unlinked`, and a
   * correction records who removed it and why. Refuses a usage that is
   * already unlinked.
   */
  async unlinkUsage(
    usageId: string,
    options: LotChangeOptions,
  ): Promise<{ usage: LotUsage; correction: LotCorrection }> {
    const reason = requireReason(options.reason);
    return this.atomically(async (tx) => {
      const usage = await tx.usages.get(usageId);
      if (!usage) throw new LotCorrectionError(`Usage not found: ${usageId}`);
      if (usage.status === 'unlinked') {
        throw new LotCorrectionError('The usage is already unlinked');
      }
      const lot = await tx.requireLot(usage.lotId);
      usage.status = 'unlinked';
      usage.unlinkedAt = new Date();
      usage.unlinkedByProfileId = options.actorProfileId ?? null;
      usage.unlinkReason = reason;
      await usage.save();
      lot.lastUsedAt = new Date();
      await lot.save();
      const correction = await tx.writeCorrection(lot, 'unlink', reason, {
        oldValue: `${usage.consumerType}:${usage.consumerId}`,
        newValue: '',
        usageId: usage.id ?? undefined,
        actorProfileId: options.actorProfileId,
      });
      return { usage, correction };
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Documents
  // ───────────────────────────────────────────────────────────────────────

  /** Attach a stored file to the lot. Repeating the same asset and role returns the active link. */
  async attachDocument(
    lotId: string,
    input: AttachDocumentInput,
  ): Promise<LotDocument> {
    const assetId = (input.assetId ?? '').trim();
    if (!assetId) throw new Error('attachDocument: assetId is required');
    const role = input.role ?? 'certificate';
    return this.atomically(async (tx) => {
      await tx.requireLot(lotId);
      const current = await tx.documents.list({
        where: { lotId, assetId, role },
      });
      const active = current.find((doc) => !doc.detachedAt);
      if (active) return active;
      return tx.documents.create({
        lotId,
        assetId,
        role,
        attachedAt: new Date(),
        attachedByProfileId: input.actorProfileId ?? null,
      });
    });
  }

  /** Detach a document. The link stays on record with `detachedAt` set. */
  async detachDocument(
    documentId: string,
    options: LotChangeOptions,
  ): Promise<{ document: LotDocument; correction: LotCorrection }> {
    const reason = requireReason(options.reason);
    return this.atomically(async (tx) => {
      const document = await tx.documents.get(documentId);
      if (!document) {
        throw new LotCorrectionError(`Document not found: ${documentId}`);
      }
      if (document.detachedAt) {
        throw new LotCorrectionError('The document is already detached');
      }
      const lot = await tx.requireLot(document.lotId);
      document.detachedAt = new Date();
      document.detachedByProfileId = options.actorProfileId ?? null;
      await document.save();
      const correction = await tx.writeCorrection(
        lot,
        'document_detach',
        reason,
        {
          oldValue: document.assetId,
          newValue: '',
          documentId: document.id ?? undefined,
          actorProfileId: options.actorProfileId,
        },
      );
      return { document, correction };
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Reads
  // ───────────────────────────────────────────────────────────────────────

  /** Every correction to the lot, oldest first. */
  async history(lotId: string): Promise<LotCorrection[]> {
    return this.corrections.list({
      where: { lotId },
      orderBy: 'correctedAt ASC',
    });
  }

  /**
   * Where a lot went: its usages, movements and documents, plus (as
   * `children`) the lots that consumed it, followed up to `depth` levels.
   */
  async traceForward(
    lotId: string,
    options: TraceOptions = {},
  ): Promise<TraceNode> {
    const depth = options.depth ?? DEFAULT_TRACE_DEPTH;
    const lot = await this.requireLot(lotId);
    return this.forwardNode(lot, options, depth, new Set([lotId]));
  }

  private async forwardNode(
    lot: Lot,
    options: TraceOptions,
    depth: number,
    path: Set<string>,
  ): Promise<TraceNode> {
    const lotId = lot.id as string;
    const usages = await this.usages.list({
      where: options.includeUnlinked ? { lotId } : { lotId, status: 'active' },
      orderBy: 'linkedAt ASC',
    });
    const children: TraceNode[] = [];
    if (depth > 0) {
      for (const usage of usages) {
        if (usage.consumerType !== 'Lot' || path.has(usage.consumerId)) {
          continue;
        }
        const child = await this.lots.get(usage.consumerId);
        if (!child) continue;
        children.push(
          await this.forwardNode(
            child,
            options,
            depth - 1,
            new Set([...path, usage.consumerId]),
          ),
        );
      }
    }
    return { ...(await this.nodeBase(lot, usages, options)), children };
  }

  /**
   * Where a consumer's material came from: one node per lot it used, each
   * with (as `children`) the lots that went into that lot when it was
   * itself an assembly (consumer `('Lot', lotId)`), up to `depth` levels.
   */
  async traceBack(
    consumerType: string,
    consumerId: string,
    options: TraceOptions = {},
  ): Promise<TraceNode[]> {
    const depth = options.depth ?? DEFAULT_TRACE_DEPTH;
    return this.backNodes(
      consumerType,
      consumerId,
      options,
      depth,
      consumerType === 'Lot' ? new Set([consumerId]) : new Set(),
    );
  }

  private async backNodes(
    consumerType: string,
    consumerId: string,
    options: TraceOptions,
    depth: number,
    path: Set<string>,
  ): Promise<TraceNode[]> {
    const edges = await this.usages.findForConsumer(consumerType, consumerId, {
      includeUnlinked: options.includeUnlinked,
    });
    const byLot = new Map<string, LotUsage[]>();
    for (const edge of edges) {
      byLot.set(edge.lotId, [...(byLot.get(edge.lotId) ?? []), edge]);
    }
    const nodes: TraceNode[] = [];
    for (const [lotId, usages] of byLot) {
      if (path.has(lotId)) continue;
      const lot = await this.lots.get(lotId);
      if (!lot) continue;
      const children =
        depth > 0
          ? await this.backNodes(
              'Lot',
              lotId,
              options,
              depth - 1,
              new Set([...path, lotId]),
            )
          : [];
      nodes.push({
        ...(await this.nodeBase(lot, usages, options)),
        children,
      });
    }
    return nodes;
  }

  private async nodeBase(
    lot: Lot,
    usages: LotUsage[],
    options: TraceOptions,
  ): Promise<Omit<TraceNode, 'children'>> {
    const lotId = lot.id as string;
    const [movements, documents] = await Promise.all([
      this.movements.list({ where: { lotId }, orderBy: 'occurredAt ASC' }),
      this.documents.list({ where: { lotId } }),
    ]);
    return {
      lot,
      usages,
      movements,
      documents: options.includeUnlinked
        ? documents
        : documents.filter((doc) => !doc.detachedAt),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────

  private atomically<T>(work: (tx: LotService) => Promise<T>): Promise<T> {
    return this.withTransaction(work);
  }

  private async requireLot(lotId: string): Promise<Lot> {
    const lot = await this.lots.get(lotId);
    if (!lot) throw new LotNotFoundError(lotId);
    return lot;
  }

  private writeCorrection(
    lot: Lot,
    kind: LotCorrectionKind,
    reason: string,
    details: {
      field?: string;
      oldValue: string;
      newValue: string;
      usageId?: string;
      documentId?: string;
      actorProfileId?: string | null;
    },
  ): Promise<LotCorrection> {
    return this.corrections.create({
      lotId: lot.id as string,
      kind,
      field: details.field ?? '',
      oldValue: details.oldValue,
      newValue: details.newValue,
      reason,
      usageId: details.usageId ?? null,
      documentId: details.documentId ?? null,
      actorProfileId: details.actorProfileId ?? null,
      correctedAt: nextCorrectionTime(),
    });
  }
}

/**
 * Convenience factory. Returns a {@link LotService} sharing the given
 * database with its internal collections.
 */
export async function createLotService(
  options: LotServiceOptions,
): Promise<LotService> {
  return LotService.create(options);
}

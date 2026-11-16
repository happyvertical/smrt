import './permissions.js';
/** Reviewed expense attribution. The original expense remains the only spend/cash authority. */
import { createHash, randomBytes } from 'node:crypto';
import {
  bindInvoiceLineSource,
  InvoiceCollection,
  InvoiceLineItemCollection,
  registerInvoiceSourceBinding,
  unbindInvoiceLineSource,
} from '@happyvertical/smrt-commerce';
import {
  isPostgresDatabase,
  ObjectRegistry,
  SmrtCollection,
  type SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  authorizeExpenseAction,
  type ExpenseActionPrincipal,
  withActionPrincipal,
} from './actions/principal.js';
import { allocationHeads, insertAllocation } from './allocation-internal.js';
import type { Expense } from './models/Expense.js';
import {
  ExpenseAllocationBilling,
  ExpenseAllocationPortion,
  ExpenseAllocationRevision,
} from './models/ExpenseAllocation.js';
import { ExpenseError, type ExpensePayer } from './types.js';
import { assertQualifiedClassName, instantMs } from './validation.js';

/** Explicit full attribution; no remainder or customer price is inferred. */
export interface ExpenseAllocationTarget {
  portionKey: string;
  costObjectType: string;
  costObjectId: string;
  costCodeRef: string;
  amountMinor: number;
}
/** Current host project authority, called for each old and proposed target. */
export interface ExpenseAllocationBillingAuthority
  extends ExpenseAllocationAuthority {
  /** Required when reserving against a host draft before a commerce invoice exists. */
  authorizeDraft?(
    principal: ExpenseActionPrincipal,
    target: Readonly<ExpenseAllocationTarget>,
    draft: { type: string; id: string },
    executor: DatabaseInterface,
  ): Promise<void>;
  /** Host must verify current invoice permissions and its project matches the portion target. */
  authorizeInvoice(
    principal: ExpenseActionPrincipal,
    target: Readonly<ExpenseAllocationTarget>,
    invoiceId: string,
    executor: DatabaseInterface,
  ): Promise<void>;
}
/** Source privacy decision distinguishes complete allocation editing from bounded portion billing. */
export interface ExpenseAllocationAuthorizationContext {
  action:
    | 'reviewAllocation'
    | 'reserveAllocation'
    | 'bindAllocation'
    | 'releaseAllocation'
    | 'withdrawAllocation';
  /** Present only for billing; contains the actor-authorized target's bounded facts, never source gross/receipts. */
  portion?: Readonly<ExpenseAllocationTarget> & { portionId: string };
}
export interface ExpenseAllocationAuthority {
  /** Mandatory for withdrawal: current authority for the restored original unsplit destination, without a fabricated cost code. */
  authorizeUnsplitTarget?(
    principal: ExpenseActionPrincipal,
    target: Readonly<{
      sourceExpenseId: string;
      costObjectType: string;
      costObjectId: string;
    }>,
    executor: DatabaseInterface,
  ): Promise<void>;
  /** Required for full allocation review/history: enforce original-source privacy independently of target grants. */
  authorizeSource(
    principal: ExpenseActionPrincipal,
    sourceExpenseId: string,
    executor: DatabaseInterface,
    context: ExpenseAllocationAuthorizationContext,
  ): Promise<void>;
  authorizeTarget(
    principal: ExpenseActionPrincipal,
    target: Readonly<ExpenseAllocationTarget>,
    executor: DatabaseInterface,
  ): Promise<void>;
}
/** One review of a positive reviewed original. Revision is the loaded source updated_at. */
export interface ReviewExpenseAllocationInput {
  sourceExpenseId: string;
  expectedSourceRevision: Date | string;
  requestId: string;
  portions: readonly ExpenseAllocationTarget[];
  reviewEvidence: string;
}
/** Detached projection safe to expose only after target authorization. No receipt URLs or other portions. */
export interface ExpenseAllocationIdentity extends ExpenseAllocationTarget {
  portionId: string;
  sourceExpenseId: string;
  revisionId: string;
  sourceFingerprint: string;
  /** Frozen source calendar date; no sibling or private receipt data. */
  incurredOn: string;
  /** Bounded economic facts, without payer identity or original source money. */
  paidBy: ExpensePayer;
  reimbursable: boolean;
  hasSupplierTax: boolean | null;
  hasRefunds: boolean;
  /** Exact only when known original basis equals gross and no refunds exist; never prorated tax. */
  costBasisMinor: number | null;
  currency: string;
  active: boolean;
}
/** Snapshot of a committed review; callers must authorize before exposing its complete target list. */
export interface ExpenseAllocationResult {
  revision: ExpenseAllocationRevision;
  portions: ExpenseAllocationIdentity[];
}

@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
class Revisions extends SmrtCollection<ExpenseAllocationRevision> {
  static readonly _itemClass = ExpenseAllocationRevision;
}
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
class Portions extends SmrtCollection<ExpenseAllocationPortion> {
  static readonly _itemClass = ExpenseAllocationPortion;
}
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
class Billings extends SmrtCollection<ExpenseAllocationBilling> {
  static readonly _itemClass = ExpenseAllocationBilling;
}
function invalid(message: string): never {
  throw new ExpenseError('EXPENSE_INVALID', `Expense allocation: ${message}`);
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 1000
  )
    invalid('bounded nonempty identifiers/evidence required.');
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function target(row: ExpenseAllocationTarget): ExpenseAllocationTarget {
  if (
    !row ||
    Object.keys(row).some(
      (key) =>
        ![
          'portionKey',
          'costObjectType',
          'costObjectId',
          'costCodeRef',
          'amountMinor',
        ].includes(key),
    )
  )
    invalid('unknown portion field.');
  for (const value of [
    row.portionKey,
    row.costObjectType,
    row.costObjectId,
    row.costCodeRef,
  ])
    text(value);
  assertQualifiedClassName(
    'ExpenseAllocation',
    row.portionKey,
    row.costObjectType,
  );
  if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0)
    invalid('portions require positive safe integer minor units.');
  return {
    portionKey: row.portionKey,
    costObjectType: row.costObjectType,
    costObjectId: row.costObjectId,
    costCodeRef: row.costCodeRef,
    amountMinor: row.amountMinor,
  };
}
/** Read immutable children using a bounded-by-source relational query, never metadata. */
async function portionsFor(
  source: Expense,
  revisionId: string,
): Promise<ExpenseAllocationPortion[]> {
  return (await Portions.create({ db: source.db })).list({
    where: { tenantId: source.tenantId, revisionId },
    limit: 1000,
    orderBy: ['portion_key ASC'],
  });
}
async function sourceFor(
  db: DatabaseInterface,
  id: string,
  tenant: string,
): Promise<Expense> {
  const { ExpenseCollection } = await import(
    './collections/ExpenseCollection.js'
  );
  const source = await (await ExpenseCollection.create({ db })).get(
    { id, tenantId: tenant },
    { cache: false },
  );
  if (!source || source.tenantId !== tenant) invalid('owned source required.');
  return source;
}
async function lock(source: Expense): Promise<void> {
  if (isPostgresDatabase(source.db))
    await source.db.query(
      `SELECT id FROM "${source.tableName}" WHERE id = ? AND tenant_id = ? FOR UPDATE`,
      source.id,
      source.tenantId,
    );
  await source.loadFromId();
}
async function authorize(
  source: Expense,
  principal: ExpenseActionPrincipal,
  authority: ExpenseAllocationAuthority,
  targets: readonly ExpenseAllocationTarget[],
): Promise<void> {
  if (typeof authority?.authorizeTarget !== 'function')
    invalid('host target authorization is required.');
  for (const item of targets) {
    const registered = ObjectRegistry.getClassByQualifiedName(
      item.costObjectType,
    );
    if (!registered) invalid('unknown cost-object type.');
    const collection = await ObjectRegistry.getCollection<SmrtObject>(
      item.costObjectType,
      { db: source.db },
    );
    const object = await collection.get(
      { id: item.costObjectId },
      { cache: false },
    );
    if (
      !object ||
      (object as unknown as { tenantId?: string }).tenantId !==
        principal.tenantId
    )
      invalid('target must exist in the active tenant.');
    await authority.authorizeTarget(
      principal,
      Object.freeze({ ...item }),
      source.db,
    );
  }
}
async function identity(
  source: Expense,
  revision: ExpenseAllocationRevision,
  row: ExpenseAllocationPortion,
): Promise<ExpenseAllocationIdentity> {
  if (!row.id || !source.id || !revision.id)
    invalid('persisted allocation identities required.');
  const { ExpenseCollection } = await import(
    './collections/ExpenseCollection.js'
  );
  const refunds = await (
    await ExpenseCollection.create({ db: source.db })
  ).list({
    where: { refundOfId: source.id, tenantId: source.tenantId },
    select: ['id'],
    limit: 1,
  });
  const hasRefunds = refunds.length > 0;
  return {
    portionId: row.id,
    sourceExpenseId: source.id,
    revisionId: revision.id,
    sourceFingerprint: revision.sourceFingerprint,
    incurredOn: revision.incurredOn,
    paidBy: revision.paidBy,
    reimbursable: revision.reimbursable,
    hasSupplierTax: revision.hasSupplierTax,
    hasRefunds,
    costBasisMinor:
      !hasRefunds && revision.basisEqualsGross ? row.amountMinor : null,
    currency: revision.currency,
    active: source.activeAllocationRevisionId === revision.id,
    portionKey: row.portionKey,
    costObjectType: row.costObjectType,
    costObjectId: row.costObjectId,
    costCodeRef: row.costCodeRef,
    amountMinor: row.amountMinor,
  };
}
async function activeReservations(
  source: Expense,
): Promise<{ id: string; portionId: string }[]> {
  const result = await source.db.query(
    `SELECT r.id, r.portion_id FROM expense_allocation_billings r
     WHERE r.source_expense_id = ? AND r.tenant_id = ? AND r.kind = 'reserve'
     AND NOT EXISTS (SELECT 1 FROM expense_allocation_billings x
       WHERE x.related_reservation_id = r.id AND x.tenant_id = r.tenant_id AND x.kind = 'release')`,
    source.id,
    source.tenantId,
  );
  return (result.rows as { id: string; portion_id: string }[]).map((row) => ({
    id: row.id,
    portionId: row.portion_id,
  }));
}

/** The one immutable chain leaf, independent of a nullable active attribution head. */
async function latestRevision(
  source: Expense,
): Promise<ExpenseAllocationRevision | null> {
  const result = await source.db.query(
    `SELECT r.id FROM expense_allocation_revisions r
    WHERE r.source_expense_id = ? AND r.tenant_id = ? AND NOT EXISTS
      (SELECT 1 FROM expense_allocation_revisions n WHERE n.previous_revision_id = r.id AND n.source_expense_id = r.source_expense_id AND n.tenant_id = r.tenant_id)
    LIMIT 2`,
    source.id,
    source.tenantId,
  );
  if (result.rows.length > 1) invalid('allocation audit chain is ambiguous.');
  const id = (result.rows[0] as { id?: string } | undefined)?.id;
  return id
    ? (await Revisions.create({ db: source.db })).get(
        { id, sourceExpenseId: source.id, tenantId: source.tenantId },
        { cache: false },
      )
    : null;
}

/** Atomically review a full allocation or supersede an unreserved revision. Identical retries reauthorize. */
export async function reviewExpenseAllocation(
  db: DatabaseInterface,
  input: ReviewExpenseAllocationInput,
  authority: ExpenseAllocationAuthority,
): Promise<ExpenseAllocationResult> {
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        ![
          'sourceExpenseId',
          'expectedSourceRevision',
          'requestId',
          'portions',
          'reviewEvidence',
        ].includes(key),
    )
  )
    invalid('unknown input field.');
  text(input.sourceExpenseId);
  text(input.requestId);
  text(input.reviewEvidence);
  if (
    instantMs(input.expectedSourceRevision) === null ||
    !Array.isArray(input.portions) ||
    input.portions.length < 1 ||
    input.portions.length > 1000
  )
    invalid('source revision and 1–1000 portions required.');
  const proposed = input.portions
    .map(target)
    .sort((a, b) =>
      a.portionKey < b.portionKey ? -1 : a.portionKey > b.portionKey ? 1 : 0,
    );
  if (new Set(proposed.map((row) => row.portionKey)).size !== proposed.length)
    invalid('duplicate portion key.');
  const fingerprint = digest({
    sourceExpenseId: input.sourceExpenseId,
    expectedSourceRevision: new Date(
      input.expectedSourceRevision,
    ).toISOString(),
    portions: proposed,
    reviewEvidence: input.reviewEvidence,
  });
  const principal = await authorizeExpenseAction(
    'expenses',
    'recordReview',
    { db },
    { allowSuperAdminBypass: false },
  );
  return withActionPrincipal(principal, async () => {
    const initial = await sourceFor(
      db,
      input.sourceExpenseId,
      principal.tenantId,
    );
    return initial.withTransaction(async (source) => {
      await lock(source);
      if (typeof authority?.authorizeSource !== 'function')
        invalid('host original-source authorization is required.');
      await authority.authorizeSource(principal, source.id!, source.db, {
        action: 'reviewAllocation',
      });
      const revisions = await Revisions.create({ db: source.db });
      const prior = await revisions.get(
        {
          sourceExpenseId: source.id,
          tenantId: principal.tenantId,
          requestId: input.requestId,
        },
        { cache: false },
      );
      if (prior) {
        if (
          prior.kind !== 'allocation' ||
          prior.requestFingerprint !== fingerprint
        )
          invalid('idempotency key payload conflict.');
        const children = await portionsFor(source, prior.id!);
        await authorize(source, principal, authority, children);
        return {
          revision: prior,
          portions: await Promise.all(
            children.map((row) => identity(source, prior, row)),
          ),
        };
      }
      if (
        instantMs(source.updated_at) !== instantMs(input.expectedSourceRevision)
      )
        invalid('stale source revision.');
      if (
        source.reviewStatus !== 'reviewed' ||
        source.duplicateOfId ||
        source.amount <= 0 ||
        source.refundOfId
      )
        invalid('positive reviewed original required.');
      const total = proposed.reduce(
        (sum, row) => sum + BigInt(row.amountMinor),
        0n,
      );
      if (total !== BigInt(source.amount))
        invalid('portions must exactly equal source amount; no remainder.');
      const old = source.activeAllocationRevisionId
        ? await portionsFor(source, source.activeAllocationRevisionId)
        : [];
      await authorize(source, principal, authority, [...old, ...proposed]);
      if ((await activeReservations(source)).length)
        invalid(
          'release draft reservations before correction; issued portions require explicit credit/reversal.',
        );
      await source.claimRevision(input.expectedSourceRevision);
      const previous = await latestRevision(source);
      if (
        source.activeAllocationRevisionId
          ? previous?.id !== source.activeAllocationRevisionId ||
            previous.kind !== 'allocation'
          : previous && previous.kind !== 'withdrawal'
      )
        invalid('allocation audit chain disagrees with its active head.');
      const sourceNonce =
        previous?.sourceFingerprintNonce || randomBytes(32).toString('hex');
      const revision = await insertAllocation(
        new (ObjectRegistry.resolveEffectiveConstructor(
          ExpenseAllocationRevision,
        ))({
          db: source.db,
          tenantId: principal.tenantId,
          sourceExpenseId: source.id!,
          previousRevisionId: previous?.id ?? null,
          kind: 'allocation',
          sourceCostObjectType: source.costObjectType,
          sourceCostObjectId: source.costObjectId,
          incurredOn: source.incurredOn,
          paidBy: source.paidBy,
          reimbursable: source.reimbursable,
          hasSupplierTax:
            source
              .getFinancialBreakdown()
              ?.taxes.some((tax) => tax.amount !== 0) ?? null,
          basisEqualsGross: source.getCostBasis()?.costBasis === source.amount,
          requestId: input.requestId,
          requestFingerprint: fingerprint,
          sourceFingerprintNonce: sourceNonce,
          sourceFingerprint: digest({
            nonce: sourceNonce,
            id: source.id,
            amount: source.amount,
            currency: source.currency,
            incurredOn: source.incurredOn,
            financialBreakdown: source.financialBreakdown,
            vendorId: source.vendorId,
            paidBy: source.paidBy,
            reimbursable: source.reimbursable,
            category: source.category,
            costObjectType: source.costObjectType,
            costObjectId: source.costObjectId,
            commitmentId: source.commitmentId,
            commitmentLineId: source.commitmentLineId,
            paidByProfileId: source.paidByProfileId,
            paidByName: source.paidByName,
          }),
          sourceRevision: new Date(input.expectedSourceRevision).toISOString(),
          amountMinor: source.amount,
          currency: source.currency,
          reviewedByProfileId: principal.profileId,
          reviewedByUserId: principal.userId,
          reviewEvidence: input.reviewEvidence,
        }),
      );
      const children: ExpenseAllocationPortion[] = [];
      for (const item of proposed)
        children.push(
          await insertAllocation(
            new (ObjectRegistry.resolveEffectiveConstructor(
              ExpenseAllocationPortion,
            ))({
              db: source.db,
              ...item,
              tenantId: principal.tenantId,
              sourceExpenseId: source.id!,
              revisionId: revision.id!,
              currency: source.currency,
            }),
          ),
        );
      source.activeAllocationRevisionId = revision.id!;
      allocationHeads.set(source, revision.id!);
      try {
        await source.save();
      } finally {
        allocationHeads.delete(source);
      }
      return {
        revision,
        portions: await Promise.all(
          children.map((row) => identity(source, revision, row)),
        ),
      };
    });
  });
}

/** An explicit decision to restore the original attribution before correcting unbilled source facts. */
export interface WithdrawExpenseAllocationInput {
  sourceExpenseId: string;
  expectedActiveRevisionId: string;
  expectedSourceRevision: Date | string;
  requestId: string;
  reviewEvidence: string;
}
/** Immutable historical result; callers reload the source for its current state/revision. */
export interface WithdrawExpenseAllocationResult {
  revision: ExpenseAllocationRevision;
  withdrawnRevisionId: string;
}
async function authorizeUnsplit(
  source: Expense,
  principal: ExpenseActionPrincipal,
  revision: ExpenseAllocationRevision,
  authority: ExpenseAllocationAuthority,
): Promise<void> {
  if (typeof authority.authorizeUnsplitTarget !== 'function')
    invalid('host restored-unsplit target authorization is required.');
  const costObjectType = revision.sourceCostObjectType;
  const costObjectId = revision.sourceCostObjectId;
  if (Boolean(costObjectType) !== Boolean(costObjectId))
    invalid('restored unsplit destination is malformed.');
  if (costObjectType) {
    if (!ObjectRegistry.getClassByQualifiedName(costObjectType))
      invalid('restored unsplit type is unknown.');
    const collection = await ObjectRegistry.getCollection<SmrtObject>(
      costObjectType,
      { db: source.db },
    );
    const object = await collection.get({ id: costObjectId }, { cache: false });
    if (
      !object ||
      (object as unknown as { tenantId?: string }).tenantId !==
        principal.tenantId
    )
      invalid('restored unsplit destination must exist in the active tenant.');
  }
  await authority.authorizeUnsplitTarget(
    principal,
    Object.freeze({
      sourceExpenseId: source.id!,
      costObjectType,
      costObjectId,
    }),
    source.db,
  );
}
/** Withdraw only entirely unreserved attribution, preserving source review state and all historical evidence. */
export async function withdrawExpenseAllocation(
  db: DatabaseInterface,
  input: WithdrawExpenseAllocationInput,
  authority: ExpenseAllocationAuthority,
): Promise<WithdrawExpenseAllocationResult> {
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        ![
          'sourceExpenseId',
          'expectedActiveRevisionId',
          'expectedSourceRevision',
          'requestId',
          'reviewEvidence',
        ].includes(key),
    )
  )
    invalid('unknown withdrawal input field.');
  text(input.sourceExpenseId);
  text(input.expectedActiveRevisionId);
  text(input.requestId);
  text(input.reviewEvidence);
  if (instantMs(input.expectedSourceRevision) === null)
    invalid('withdrawal source revision is required.');
  const fingerprint = digest({
    action: 'withdrawAllocation',
    sourceExpenseId: input.sourceExpenseId,
    expectedActiveRevisionId: input.expectedActiveRevisionId,
    expectedSourceRevision: new Date(
      input.expectedSourceRevision,
    ).toISOString(),
    reviewEvidence: input.reviewEvidence,
  });
  const principal = await billingPrincipal(db);
  return withActionPrincipal(principal, async () => {
    return (
      await sourceFor(db, input.sourceExpenseId, principal.tenantId)
    ).withTransaction(async (source) => {
      await lock(source);
      if (typeof authority?.authorizeSource !== 'function')
        invalid('host original-source authorization is required.');
      await authority.authorizeSource(principal, source.id!, source.db, {
        action: 'withdrawAllocation',
      });
      const revisions = await Revisions.create({ db: source.db });
      const replay = await revisions.get(
        {
          sourceExpenseId: source.id,
          tenantId: principal.tenantId,
          requestId: input.requestId,
        },
        { cache: false },
      );
      if (
        replay &&
        (replay.kind !== 'withdrawal' ||
          replay.requestFingerprint !== fingerprint)
      )
        invalid('withdrawal idempotency key payload conflict.');
      const targetRevisionId =
        replay?.previousRevisionId ?? input.expectedActiveRevisionId;
      const previous = await revisions.get(
        {
          id: targetRevisionId,
          sourceExpenseId: source.id,
          tenantId: principal.tenantId,
        },
        { cache: false },
      );
      if (!previous || previous.kind !== 'allocation')
        invalid(
          'withdrawal requires the original reviewed allocation revision.',
        );
      const old = await portionsFor(source, previous.id!);
      await authorize(source, principal, authority, old);
      await authorizeUnsplit(source, principal, previous, authority);
      if (replay)
        return { revision: replay, withdrawnRevisionId: previous.id! };
      if (
        source.activeAllocationRevisionId !== input.expectedActiveRevisionId ||
        instantMs(source.updated_at) !== instantMs(input.expectedSourceRevision)
      )
        invalid('stale active allocation or source revision.');
      if ((await latestRevision(source))?.id !== previous.id)
        invalid('withdrawal audit chain is not current.');
      if ((await activeReservations(source)).length)
        invalid(
          'reserved, bound or issued portions cannot be withdrawn; release authorized draft claims explicitly.',
        );
      await source.claimRevision(input.expectedSourceRevision);
      const revision = await insertAllocation(
        new (ObjectRegistry.resolveEffectiveConstructor(
          ExpenseAllocationRevision,
        ))({
          db: source.db,
          tenantId: principal.tenantId,
          sourceExpenseId: source.id!,
          previousRevisionId: previous.id!,
          kind: 'withdrawal',
          requestId: input.requestId,
          requestFingerprint: fingerprint,
          sourceFingerprint: previous.sourceFingerprint,
          sourceFingerprintNonce: previous.sourceFingerprintNonce,
          sourceRevision: new Date(input.expectedSourceRevision).toISOString(),
          amountMinor: previous.amountMinor,
          currency: previous.currency,
          sourceCostObjectType: previous.sourceCostObjectType,
          sourceCostObjectId: previous.sourceCostObjectId,
          incurredOn: previous.incurredOn,
          paidBy: previous.paidBy,
          reimbursable: previous.reimbursable,
          hasSupplierTax: previous.hasSupplierTax,
          basisEqualsGross: previous.basisEqualsGross,
          reviewedByProfileId: principal.profileId,
          reviewedByUserId: principal.userId,
          reviewEvidence: input.reviewEvidence,
        }),
      );
      source.activeAllocationRevisionId = null;
      allocationHeads.set(source, null);
      try {
        await source.save();
      } finally {
        allocationHeads.delete(source);
      }
      return { revision, withdrawnRevisionId: previous.id! };
    });
  });
}

/** Resolve one canonical portion with current project authority, including historical billed revisions. */
export async function resolveExpenseAllocationPortion(
  db: DatabaseInterface,
  portionId: string,
  authority: ExpenseAllocationAuthority,
): Promise<ExpenseAllocationIdentity> {
  text(portionId);
  const principal = await authorizeExpenseAction(
    'expenses',
    'get',
    { db },
    { allowSuperAdminBypass: false },
  );
  return withActionPrincipal(principal, async () => {
    const row = await (await Portions.create({ db })).get(
      { id: portionId, tenantId: principal.tenantId },
      { cache: false },
    );
    if (!row) invalid('owned portion required.');
    const source = await sourceFor(db, row.sourceExpenseId, principal.tenantId);
    if (
      source.activeAllocationRevisionId === row.revisionId &&
      (source.reviewStatus !== 'reviewed' || source.duplicateOfId)
    )
      invalid('source review is no longer usable.');
    const revision = await (await Revisions.create({ db })).get(
      { id: row.revisionId, tenantId: principal.tenantId },
      { cache: false },
    );
    if (!revision || revision.sourceExpenseId !== source.id)
      invalid('owned revision required.');
    await authorize(source, principal, authority, [row]);
    return identity(source, revision, row);
  });
}

/** Internal monetary projection: source rows remain canonical for cash/tax/commitment. */
export async function allocationTargetAmount(
  source: Expense,
  filter: Record<string, unknown>,
): Promise<number | null> {
  if (!source.activeAllocationRevisionId) {
    if (Object.keys(filter).some((key) => key.startsWith('costCodeRef')))
      return null;
    const { ExpenseCollection } = await import(
      './collections/ExpenseCollection.js'
    );
    const match = await (await ExpenseCollection.create({ db: source.db })).get(
      { ...filter, id: source.id, tenantId: source.tenantId },
      { cache: false },
    );
    return match ? source.amount : null;
  }
  const rows = await (await Portions.create({ db: source.db })).list({
    where: {
      ...filter,
      revisionId: source.activeAllocationRevisionId,
      tenantId: source.tenantId,
    },
    limit: 1000,
  });
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    invalid('target sum exceeds safe range.');
  return Number(total);
}

/** Protected commerce source protocol. Unqualified/ordinary invoice sources retain their old behavior. */
export const EXPENSE_ALLOCATION_INVOICE_SOURCE =
  'billable:@happyvertical/smrt-expenses:ExpenseAllocationPortion';
/** Reserve against a host-owned draft first, or bind directly to a prepared commerce line. */
export interface ReserveExpenseAllocationInput {
  portionId: string;
  requestId: string;
  draftType?: string;
  draftId?: string;
  invoiceId?: string;
  invoiceLineId?: string;
}
async function reservationFor(
  db: DatabaseInterface,
  id: string,
  tenantId: string,
): Promise<ExpenseAllocationBilling> {
  const reservation = await (await Billings.create({ db })).get(
    { id, tenantId },
    { cache: false },
  );
  if (
    !reservation ||
    reservation.kind !== 'reserve' ||
    reservation.tenantId !== tenantId
  )
    invalid('owned reservation required.');
  return reservation;
}
async function bindingFor(
  source: Expense,
  reservationId: string,
): Promise<ExpenseAllocationBilling | null> {
  return (await Billings.create({ db: source.db })).get(
    {
      sourceExpenseId: source.id,
      relatedReservationId: reservationId,
      kind: 'bind',
      tenantId: source.tenantId,
    },
    { cache: false },
  );
}
async function billingPrincipal(
  db: DatabaseInterface,
): Promise<ExpenseActionPrincipal> {
  return authorizeExpenseAction(
    'expenses',
    'recordReview',
    { db },
    { allowSuperAdminBypass: false },
  );
}
async function billingPortion(
  source: Expense,
  id: string,
  principal: ExpenseActionPrincipal,
  authority: ExpenseAllocationBillingAuthority,
  action: ExpenseAllocationAuthorizationContext['action'],
): Promise<ExpenseAllocationPortion> {
  const portion = await (await Portions.create({ db: source.db })).get(
    { id, sourceExpenseId: source.id, tenantId: principal.tenantId },
    { cache: false },
  );
  if (!portion) invalid('owned source portion required.');
  await authorize(source, principal, authority, [portion]);
  if (typeof authority.authorizeSource !== 'function')
    invalid('host source authority required.');
  await authority.authorizeSource(principal, source.id!, source.db, {
    action,
    portion: {
      portionId: portion.id!,
      portionKey: portion.portionKey,
      costObjectType: portion.costObjectType,
      costObjectId: portion.costObjectId,
      costCodeRef: portion.costCodeRef,
      amountMinor: portion.amountMinor,
    },
  });
  return portion;
}
/** Reserve full exact source capacity once, without implying customer price or creating another expense. */
export async function reserveExpenseAllocationPortion(
  db: DatabaseInterface,
  input: ReserveExpenseAllocationInput,
  authority: ExpenseAllocationBillingAuthority,
): Promise<ExpenseAllocationBilling> {
  text(input.portionId);
  text(input.requestId);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'portionId',
          'requestId',
          'draftType',
          'draftId',
          'invoiceId',
          'invoiceLineId',
        ].includes(key),
    )
  )
    invalid('unknown reservation field.');
  const principal = await billingPrincipal(db);
  return withActionPrincipal(principal, async () => {
    const row = await (await Portions.create({ db })).get(
      { id: input.portionId, tenantId: principal.tenantId },
      { cache: false },
    );
    if (!row) invalid('owned portion required.');
    return (
      await sourceFor(db, row.sourceExpenseId, principal.tenantId)
    ).withTransaction(async (source) => {
      await lock(source);
      const portion = await billingPortion(
        source,
        row.id!,
        principal,
        authority,
        'reserveAllocation',
      );
      const invoiceBound = Boolean(input.invoiceId || input.invoiceLineId);
      if (invoiceBound) {
        text(input.invoiceId);
        text(input.invoiceLineId);
        if (typeof authority.authorizeInvoice !== 'function')
          invalid('host invoice authority required.');
        await authority.authorizeInvoice(
          principal,
          portion,
          input.invoiceId,
          source.db,
        );
      } else {
        text(input.draftType);
        text(input.draftId);
        if (typeof authority.authorizeDraft !== 'function')
          invalid('host draft authority required.');
        await authority.authorizeDraft(
          principal,
          portion,
          { type: input.draftType, id: input.draftId },
          source.db,
        );
      }
      const fingerprint = digest({
        portionId: input.portionId,
        requestId: input.requestId,
        draftType: input.draftType ?? null,
        draftId: input.draftId ?? null,
        invoiceId: input.invoiceId ?? null,
        invoiceLineId: input.invoiceLineId ?? null,
      });
      const billings = await Billings.create({ db: source.db });
      const prior = await billings.get(
        {
          sourceExpenseId: source.id,
          tenantId: principal.tenantId,
          requestId: input.requestId,
        },
        { cache: false },
      );
      if (prior) {
        if (
          prior.requestFingerprint !== fingerprint ||
          prior.kind !== 'reserve'
        )
          invalid('reservation idempotency conflict.');
        return prior;
      }
      if ((await source.getRefundPosition()).refundIds.length)
        invalid('refunded source needs explicit billing reversal policy.');
      if (source.activeAllocationRevisionId !== portion.revisionId)
        invalid('superseded portion cannot be reserved.');
      if (
        (await activeReservations(source)).some(
          (item) => item.portionId === portion.id,
        )
      )
        invalid('portion capacity already reserved.');
      if (!source.updated_at) invalid('source revision required.');
      await source.claimRevision(source.updated_at);
      const reservation = await insertAllocation(
        new (ObjectRegistry.resolveEffectiveConstructor(
          ExpenseAllocationBilling,
        ))({
          db: source.db,
          tenantId: principal.tenantId,
          sourceExpenseId: source.id!,
          portionId: portion.id!,
          requestId: input.requestId,
          requestFingerprint: fingerprint,
          kind: 'reserve',
          draftType: input.draftType ?? '',
          draftId: input.draftId ?? '',
        }),
      );
      if (invoiceBound)
        await bindReservation(
          source,
          reservation,
          portion,
          {
            invoiceId: input.invoiceId!,
            invoiceLineId: input.invoiceLineId!,
            requestId: `${input.requestId}:bind`,
          },
          principal,
          authority,
        );
      return reservation;
    });
  });
}
async function bindReservation(
  source: Expense,
  reservation: ExpenseAllocationBilling,
  portion: ExpenseAllocationPortion,
  input: { invoiceId: string; invoiceLineId: string; requestId: string },
  principal: ExpenseActionPrincipal,
  authority: ExpenseAllocationBillingAuthority,
): Promise<ExpenseAllocationBilling> {
  if (typeof authority.authorizeInvoice !== 'function')
    invalid('host invoice authority required.');
  await authority.authorizeInvoice(
    principal,
    portion,
    input.invoiceId,
    source.db,
  );
  const billings = await Billings.create({ db: source.db });
  const fingerprint = digest({ reservationId: reservation.id, ...input });
  const previous = await bindingFor(source, reservation.id!);
  if (previous) {
    if (
      previous.requestId !== input.requestId ||
      previous.requestFingerprint !== fingerprint
    )
      invalid('reservation already bound or payload changed.');
    return previous;
  }
  if ((await source.getRefundPosition()).refundIds.length)
    invalid('refunded source needs explicit billing reversal policy.');
  if (
    !(await activeReservations(source)).some(
      (item) => item.id === reservation.id,
    )
  )
    invalid('released reservation cannot bind.');
  if (
    await billings.get(
      {
        sourceExpenseId: source.id,
        tenantId: principal.tenantId,
        requestId: input.requestId,
      },
      { cache: false },
    )
  )
    invalid('request identity already used.');
  const invoice = await (await InvoiceCollection.create({ db: source.db })).get(
    { id: input.invoiceId, tenantId: principal.tenantId },
    { cache: false },
  );
  const line = await (
    await InvoiceLineItemCollection.create({ db: source.db })
  ).get(
    { id: input.invoiceLineId, tenantId: principal.tenantId },
    { cache: false },
  );
  if (
    !invoice ||
    invoice.tenantId !== principal.tenantId ||
    invoice.status !== 'draft' ||
    invoice.currency !== portion.currency ||
    !line ||
    line.tenantId !== principal.tenantId ||
    line.invoiceId !== invoice.id ||
    line.sourceType !== EXPENSE_ALLOCATION_INVOICE_SOURCE ||
    line.sourceId !== portion.id ||
    !invoice.updated_at ||
    !source.updated_at
  )
    invalid('owned same-currency draft and canonical source line required.');
  await invoice.claimRevision(invoice.updated_at);
  await source.claimRevision(source.updated_at);
  const binding = await insertAllocation(
    new (ObjectRegistry.resolveEffectiveConstructor(ExpenseAllocationBilling))({
      db: source.db,
      tenantId: principal.tenantId,
      sourceExpenseId: source.id!,
      portionId: portion.id!,
      invoiceId: input.invoiceId,
      invoiceLineId: input.invoiceLineId,
      requestId: input.requestId,
      requestFingerprint: fingerprint,
      kind: 'bind',
      relatedReservationId: reservation.id!,
    }),
  );
  await bindInvoiceLineSource({
    db: source.db,
    tenantId: principal.tenantId,
    lineId: input.invoiceLineId,
    reservationId: reservation.id!,
  });
  return binding;
}
/** Transition the existing host draft claim to exactly one commerce line, without reserving twice. */
export async function bindExpenseAllocationPortion(
  db: DatabaseInterface,
  reservationId: string,
  input: { invoiceId: string; invoiceLineId: string; requestId: string },
  authority: ExpenseAllocationBillingAuthority,
): Promise<ExpenseAllocationBilling> {
  text(reservationId);
  text(input.invoiceId);
  text(input.invoiceLineId);
  text(input.requestId);
  const principal = await billingPrincipal(db);
  return withActionPrincipal(principal, async () => {
    const reservation = await reservationFor(
      db,
      reservationId,
      principal.tenantId,
    );
    return (
      await sourceFor(db, reservation.sourceExpenseId, principal.tenantId)
    ).withTransaction(async (source) => {
      await lock(source);
      const portion = await billingPortion(
        source,
        reservation.portionId,
        principal,
        authority,
        'bindAllocation',
      );
      return bindReservation(
        source,
        reservation,
        portion,
        input,
        principal,
        authority,
      );
    });
  });
}
/** Release an unissued draft claim and its commerce pointer atomically; issued reservations remain consumed. */
export async function releaseExpenseAllocationPortion(
  db: DatabaseInterface,
  reservationId: string,
  requestId: string,
  authority: ExpenseAllocationBillingAuthority,
): Promise<ExpenseAllocationBilling> {
  text(reservationId);
  text(requestId);
  const principal = await billingPrincipal(db);
  return withActionPrincipal(principal, async () => {
    const reservation = await reservationFor(
      db,
      reservationId,
      principal.tenantId,
    );
    return (
      await sourceFor(db, reservation.sourceExpenseId, principal.tenantId)
    ).withTransaction(async (source) => {
      await lock(source);
      const portion = await billingPortion(
        source,
        reservation.portionId,
        principal,
        authority,
        'releaseAllocation',
      );
      const binding = await bindingFor(source, reservation.id!);
      if (binding?.invoiceId) {
        if (typeof authority.authorizeInvoice !== 'function')
          invalid('host invoice authority required.');
        await authority.authorizeInvoice(
          principal,
          portion,
          binding.invoiceId,
          source.db,
        );
      } else {
        if (typeof authority.authorizeDraft !== 'function')
          invalid('host draft authority required.');
        await authority.authorizeDraft(
          principal,
          portion,
          { type: reservation.draftType, id: reservation.draftId },
          source.db,
        );
      }
      const billings = await Billings.create({ db: source.db });
      const fingerprint = digest({ reservationId, requestId });
      const prior = await billings.get(
        { sourceExpenseId: source.id, tenantId: principal.tenantId, requestId },
        { cache: false },
      );
      if (prior) {
        if (
          prior.requestFingerprint !== fingerprint ||
          prior.kind !== 'release'
        )
          invalid('release idempotency conflict.');
        return prior;
      }
      if (
        !(await activeReservations(source)).some(
          (item) => item.id === reservationId,
        )
      )
        invalid('reservation already released.');
      if (binding?.invoiceId) {
        const invoice = await (
          await InvoiceCollection.create({ db: source.db })
        ).get(
          { id: binding.invoiceId, tenantId: principal.tenantId },
          { cache: false },
        );
        if (!invoice || invoice.status !== 'draft' || !invoice.updated_at)
          invalid(
            'issued reservation cannot be released; use explicit credit/reversal.',
          );
        await invoice.claimRevision(invoice.updated_at);
      }
      if (!source.updated_at) invalid('source revision required.');
      await source.claimRevision(source.updated_at);
      const released = await insertAllocation(
        new (ObjectRegistry.resolveEffectiveConstructor(
          ExpenseAllocationBilling,
        ))({
          db: source.db,
          tenantId: principal.tenantId,
          sourceExpenseId: source.id!,
          portionId: reservation.portionId,
          invoiceId: binding?.invoiceId ?? null,
          invoiceLineId: binding?.invoiceLineId ?? null,
          requestId,
          requestFingerprint: fingerprint,
          kind: 'release',
          relatedReservationId: reservationId,
          draftType: reservation.draftType,
          draftId: reservation.draftId,
        }),
      );
      if (binding?.invoiceLineId)
        await unbindInvoiceLineSource({
          db: source.db,
          tenantId: principal.tenantId,
          lineId: binding.invoiceLineId,
          reservationId,
        });
      return released;
    });
  });
}

// Static, trusted package registration; request strings can select only this closed capability.
registerInvoiceSourceBinding(
  EXPENSE_ALLOCATION_INVOICE_SOURCE,
  async ({ executor, invoice, line, reservationId, phase }) => {
    if (!invoice.tenantId || line.tenantId !== invoice.tenantId)
      invalid('binding tenant mismatch.');
    const reservation = await reservationFor(
      executor,
      reservationId,
      invoice.tenantId,
    );
    const source = await sourceFor(
      executor,
      reservation.sourceExpenseId,
      invoice.tenantId,
    );
    const binding = await bindingFor(source, reservationId);
    if (
      !binding ||
      binding.invoiceId !== invoice.id ||
      binding.invoiceLineId !== line.id ||
      line.sourceId !== reservation.portionId ||
      line.sourceType !== EXPENSE_ALLOCATION_INVOICE_SOURCE
    )
      invalid('binding does not identify this exact invoice line.');
    const active = (await activeReservations(source)).some(
      (item) => item.id === reservationId,
    );
    if (phase === 'release' ? active : !active)
      invalid('binding reservation state is invalid.');
  },
);

/** Bounded target-owned availability; historical/issued claims never become available implicitly. */
export interface ExpenseAllocationPortionPosition {
  identity: ExpenseAllocationIdentity;
  available: boolean;
  reservation: {
    reservationId: string;
    draftType: string;
    draftId: string;
    invoiceId: string | null;
    invoiceLineId: string | null;
    invoiceStatus: string | null;
    issued: boolean;
  } | null;
}
/** Read one portion's current claim without disclosing original receipts, source gross or sibling projects. */
export async function getExpenseAllocationPortionPosition(
  db: DatabaseInterface,
  portionId: string,
  authority: ExpenseAllocationAuthority,
): Promise<ExpenseAllocationPortionPosition> {
  const identity = await resolveExpenseAllocationPortion(
    db,
    portionId,
    authority,
  );
  const principal = await authorizeExpenseAction(
    'expenses',
    'get',
    { db },
    { allowSuperAdminBypass: false },
  );
  return withActionPrincipal(principal, async () => {
    const source = await sourceFor(
      db,
      identity.sourceExpenseId,
      principal.tenantId,
    );
    identity.active = source.activeAllocationRevisionId === identity.revisionId;
    const active = (await activeReservations(source)).find(
      (row) => row.portionId === portionId,
    );
    if (!active)
      return { identity, available: identity.active, reservation: null };
    const reservation = await reservationFor(db, active.id, principal.tenantId);
    const binding = await bindingFor(source, active.id);
    const invoice = binding?.invoiceId
      ? await (await InvoiceCollection.create({ db })).get(
          { id: binding.invoiceId, tenantId: principal.tenantId },
          { cache: false },
        )
      : null;
    return {
      identity,
      available: false,
      reservation: {
        reservationId: reservation.id!,
        draftType: reservation.draftType,
        draftId: reservation.draftId,
        invoiceId: binding?.invoiceId ?? null,
        invoiceLineId: binding?.invoiceLineId ?? null,
        invoiceStatus: invoice?.status ?? null,
        issued: Boolean(binding && (!invoice || invoice.status !== 'draft')),
      },
    };
  });
}

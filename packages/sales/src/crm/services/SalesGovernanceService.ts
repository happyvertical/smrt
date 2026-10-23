/** Authorized seller, canonical advertiser leases and exact maker/checker terms. */
import { createHash } from 'node:crypto';
import { requireTenantId } from '@happyvertical/smrt-tenancy';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { SalesGovernanceEventCollection } from '../collections/SalesGovernanceEventCollection.js';
import { SalesGovernanceStateCollection } from '../collections/SalesGovernanceStateCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';
import type { SalesGovernanceState } from '../models/SalesGovernanceState.js';
import { withGovernanceWrite } from './governance-write.js';
import type {
  SalesAdvertiserLease,
  SalesApprovalDecision,
  SalesCreateQuoteInput,
  SalesGovernanceDatabaseConfig,
  SalesGovernanceHost,
  SalesLeaseChangeInput,
  SalesLeaseInput,
  SalesQuoteOperation,
  SalesQuoteSnapshot,
  SalesQuoteTerms,
  SellerContext,
  SellerOperation,
  SellerPolicy,
} from './sales-governance-types.js';

export class SalesGovernanceError extends Error {
  readonly code = 'SALES_GOVERNANCE_DENIED';
  constructor(readonly reason: string) {
    super(`Sales governance refused: ${reason}`);
    this.name = 'SalesGovernanceError';
  }
}
const ownedTransactions = new WeakSet<DatabaseInterface>();

interface TransactionDatabase extends DatabaseInterface {
  transaction?<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}
interface Deps {
  states: SalesGovernanceStateCollection;
  events: SalesGovernanceEventCollection;
  reps: SalesRepresentativeCollection;
}

/** All writes run in one transaction, or participate in the explicitly supplied executor. */
export class SalesGovernanceService {
  readonly #database: DatabaseInterface;
  readonly #backend: SalesGovernanceDatabaseConfig['type'];

  private constructor(
    database: DatabaseInterface,
    backend: SalesGovernanceDatabaseConfig['type'],
    private readonly host: SalesGovernanceHost,
    private readonly now: () => Date,
  ) {
    this.#database = database;
    this.#backend = backend;
  }

  /** Owned adapter for migrations and host reads; transaction writes use withTransaction. */
  get database(): DatabaseInterface {
    return this.#database;
  }

  static async create(options: {
    database: SalesGovernanceDatabaseConfig;
    host: SalesGovernanceHost;
    now?: () => Date;
  }): Promise<SalesGovernanceService> {
    // SQL has no public engine identity on arbitrary DatabaseInterface values.
    // Own connection creation so unsupported adapters cannot masquerade as a
    // transactional authority store. DuckDB support is blocked on SDK #1452:
    // https://github.com/happyvertical/sdk/issues/1452
    // SQLite is also excluded: a Sales same-process BUSY/close/recreate
    // recovery has not been established on the published SQL adapter.
    const configuration = { ...options?.database };
    const backend = configuration.type;
    if (backend !== 'postgres') deny('unsupported_backend');
    const allowed = new Set([
      'type',
      'url',
      'cache',
      'dbid',
      'max',
      'connectionTimeoutMillis',
      'idleTimeoutMillis',
    ]);
    if (
      typeof configuration.url !== 'string' ||
      !configuration.url.trim() ||
      Object.keys(configuration).some((field) => !allowed.has(field)) ||
      (configuration.cache !== undefined && configuration.cache !== false)
    )
      deny('invalid_database_configuration');
    if (!options.host) deny('host_required');
    const db = await getDatabase({ ...configuration, cache: false });
    return new SalesGovernanceService(
      db,
      backend,
      options.host,
      options.now ?? (() => new Date()),
    );
  }

  /**
   * Run host writes and any governance mutations on one positively identified
   * executor. A thrown callback rolls back all changes. Do not retain tx.
   */
  async withTransaction<T>(
    fn: (tx: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    this.assertBackend();
    const db = this.database as TransactionDatabase;
    if (typeof db.transaction !== 'function') deny('transaction_unavailable');
    return db.transaction(async (tx) => {
      ownedTransactions.add(tx);
      try {
        return await fn(tx);
      } finally {
        ownedTransactions.delete(tx);
      }
    });
  }

  /** First successful registration wins until expiresAtMs <= now, or release. */
  async acquireLease(
    input: SalesLeaseInput,
    transaction?: DatabaseInterface,
  ): Promise<SalesAdvertiserLease> {
    input = { ...input };
    return this.operation('acquire', input, transaction, async (deps, db) => {
      const policy = await this.seller(input, input.sellerId, deps, db);
      await this.advertiser(input, input.advertiserId, db);
      const state = await deps.states.lock(
        key('lease', input.tenantId, input.advertiserId),
      );
      const previous = parse<SalesAdvertiserLease>(state.payload);
      const now = this.time();
      if (previous && !previous.released && previous.expiresAtMs > now)
        deny('advertiser_already_registered');
      const lease: SalesAdvertiserLease = {
        tenantId: input.tenantId,
        advertiserId: input.advertiserId,
        sellerId: input.sellerId,
        leaseId: input.operationId,
        expiresAtMs: expiry(now, policy.leaseDurationMs),
        released: false,
      };
      await this.store(deps, state, lease);
      return lease;
    });
  }

  /** Renewal requires a live matching owner token; it starts a fresh policy duration. */
  async renewLease(
    input: SalesLeaseChangeInput,
    transaction?: DatabaseInterface,
  ): Promise<SalesAdvertiserLease> {
    return this.changeLease('renew', input, transaction);
  }

  /** Release never transfers ownership and is audited even at the expiry boundary. */
  async releaseLease(
    input: SalesLeaseChangeInput,
    transaction?: DatabaseInterface,
  ): Promise<SalesAdvertiserLease> {
    return this.changeLease('release', input, transaction);
  }

  private async changeLease(
    kind: 'renew' | 'release',
    input: SalesLeaseChangeInput,
    tx?: DatabaseInterface,
  ): Promise<SalesAdvertiserLease> {
    input = { ...input };
    return this.operation(kind, input, tx, async (deps, db) => {
      const policy = await this.seller(input, input.sellerId, deps, db);
      await this.advertiser(input, input.advertiserId, db);
      const state = await deps.states.lock(
        key('lease', input.tenantId, input.advertiserId),
      );
      const lease = parse<SalesAdvertiserLease>(state.payload);
      if (
        !lease ||
        lease.leaseId !== input.leaseId ||
        lease.sellerId !== input.sellerId ||
        lease.released
      )
        deny('lease_owner_mismatch');
      if (kind === 'renew') {
        if (lease.expiresAtMs <= this.time()) deny('lease_expired');
        lease.expiresAtMs = expiry(this.time(), policy.leaseDurationMs);
      } else lease.released = true;
      await this.store(deps, state, lease);
      return lease;
    });
  }

  /** Freeze one immutable commercial revision. Amendments use a greater revision. */
  async createQuote(
    input: SalesCreateQuoteInput,
    transaction?: DatabaseInterface,
  ): Promise<SalesQuoteSnapshot> {
    input = { ...input, terms: { ...input.terms } };
    validateTerms(input.terms);
    return this.operation('quote', input, transaction, async (deps, db) => {
      const policy = await this.seller(input, input.terms.sellerId, deps, db);
      await this.advertiser(input, input.terms.advertiserId, db);
      if (
        (await this.host.validateQuote(
          { ...input.terms, tenantId: input.tenantId },
          db,
        )) !== true
      )
        deny('quote_unavailable');
      const head = await deps.states.lock(
        key('quote-head', input.tenantId, input.terms.quoteId),
      );
      const previous = parse<{ revision: number }>(head.payload);
      if (previous && previous.revision >= input.terms.revision)
        deny('quote_revision_not_new');
      const state = await deps.states.lock(
        quoteKey(input.tenantId, input.terms.quoteId, input.terms.revision),
      );
      if (parse(state.payload)) deny('quote_revision_exists');
      const quote: SalesQuoteSnapshot = {
        ...input.terms,
        tenantId: input.tenantId,
        makerProfileId: input.actorProfileId,
        policy,
        status: 'draft',
        approval: null,
      };
      await this.store(deps, state, quote);
      await this.store(deps, head, { revision: quote.revision });
      return quote;
    });
  }

  async requestApproval(
    input: SalesQuoteOperation,
    transaction?: DatabaseInterface,
  ): Promise<SalesQuoteSnapshot> {
    input = { ...input };
    return this.operation(
      'request-approval',
      input,
      transaction,
      async (deps, db) => {
        const [state, quote] = await this.quote(input, deps);
        await this.validateSellerQuote(input, quote, deps, db);
        if (quote.status !== 'draft' || quote.approval)
          deny('approval_already_requested');
        quote.approval = {
          requestId: input.operationId,
          status: 'pending',
          termsHash: termsHash(quote),
          checkerProfileId: null,
          expiresAtMs: expiry(this.time(), quote.policy.approvalDurationMs),
          reason: '',
        };
        await this.store(deps, state, quote);
        return quote;
      },
    );
  }

  async decideApproval(
    input: SalesApprovalDecision,
    transaction?: DatabaseInterface,
  ): Promise<SalesQuoteSnapshot> {
    input = { ...input };
    if (
      !['approved', 'rejected', 'revoked'].includes(input.decision) ||
      !input.reason?.trim()
    )
      deny('invalid_decision');
    return this.operation(
      'decide-approval',
      input,
      transaction,
      async (deps, db) => {
        const [state, quote] = await this.quote(input, deps);
        await this.context(input, db);
        if (input.actorProfileId === quote.makerProfileId)
          deny('self_approval');
        if ((await this.host.canApprove(input, db)) !== true)
          deny('finance_unauthorized');
        const approval = quote.approval;
        if (
          !approval ||
          approval.requestId !== input.requestId ||
          approval.termsHash !== termsHash(quote)
        )
          deny('approval_mismatch');
        if (input.decision === 'revoked') {
          if (approval.status !== 'approved') deny('approval_not_approved');
        } else {
          if (approval.status !== 'pending' || quote.status !== 'draft')
            deny('approval_not_pending');
          if (approval.expiresAtMs <= this.time()) deny('approval_expired');
        }
        approval.status = input.decision;
        approval.checkerProfileId = input.actorProfileId;
        approval.reason = input.reason.trim();
        await this.store(deps, state, quote);
        return quote;
      },
    );
  }

  async issueQuote(
    input: SalesQuoteOperation,
    transaction?: DatabaseInterface,
  ): Promise<SalesQuoteSnapshot> {
    return this.transition('issue', input, transaction);
  }

  /** Commit local sign authority before provider I/O; never send directly from a stale quote. */
  async signQuote(
    input: SalesQuoteOperation,
    transaction?: DatabaseInterface,
  ): Promise<SalesQuoteSnapshot> {
    return this.transition('sign', input, transaction);
  }

  private async transition(
    kind: 'issue' | 'sign',
    input: SalesQuoteOperation,
    tx?: DatabaseInterface,
  ): Promise<SalesQuoteSnapshot> {
    input = { ...input };
    return this.operation(kind, input, tx, async (deps, db) => {
      const [state, quote] = await this.quote(input, deps);
      await this.validateSellerQuote(input, quote, deps, db);
      if (
        kind === 'issue' ? quote.status !== 'draft' : quote.status !== 'issued'
      )
        deny('invalid_quote_transition');
      this.approved(quote);
      quote.status = kind === 'issue' ? 'issued' : 'signed';
      await this.store(deps, state, quote);
      return quote;
    });
  }

  /** Provider preflight, including retries of already-signed local records. */
  async assertCanSign(
    input: Omit<SalesQuoteOperation, 'operationId'>,
    transaction?: DatabaseInterface,
  ): Promise<void> {
    input = { ...input };
    this.assertContext(input);
    await this.run(transaction, async (deps, db) => {
      const [, quote] = await this.quote(input, deps);
      await this.validateSellerQuote(input, quote, deps, db);
      if (quote.status !== 'signed') deny('quote_not_signed');
      this.approved(quote);
    });
  }

  /** Read canonical registration for an authorized current tenant member. */
  async getLease(
    input: SellerContext & { advertiserId: string },
  ): Promise<SalesAdvertiserLease | null> {
    this.assertContext(input);
    return this.run(undefined, async (deps, db) => {
      await this.context(input, db);
      await this.advertiser(input, input.advertiserId, db);
      const state = await deps.states.get(
        { id: key('lease', input.tenantId, input.advertiserId) },
        { cache: false },
      );
      return state ? parse<SalesAdvertiserLease>(state.payload) : null;
    });
  }

  /** Tenant-scoped UI projection. Authority is always rechecked by mutation methods. */
  async getQuote(input: {
    tenantId: string;
    quoteId: string;
    revision: number;
  }): Promise<SalesQuoteSnapshot | null> {
    if (requireTenantId() !== input.tenantId) deny('tenant_context_mismatch');
    const states = await SalesGovernanceStateCollection.create({
      db: this.database,
    });
    const state = await states.get(
      { id: quoteKey(input.tenantId, input.quoteId, input.revision) },
      { cache: false },
    );
    return state ? parse<SalesQuoteSnapshot>(state.payload) : null;
  }

  private approved(quote: SalesQuoteSnapshot): void {
    const discount = BigInt(quote.subtotalCents - quote.totalCents) * 10000n;
    if (
      discount <=
      BigInt(quote.subtotalCents) * BigInt(quote.policy.maxDiscountBps)
    )
      return;
    const approval = quote.approval;
    if (
      !approval ||
      approval.status !== 'approved' ||
      approval.expiresAtMs <= this.time() ||
      approval.termsHash !== termsHash(quote) ||
      !approval.checkerProfileId ||
      approval.checkerProfileId === quote.makerProfileId
    )
      deny('discount_approval_required');
  }

  private async validateSellerQuote(
    input: SellerContext,
    quote: SalesQuoteSnapshot,
    deps: Deps,
    db: DatabaseInterface,
  ): Promise<void> {
    const policy = await this.seller(input, quote.sellerId, deps, db);
    if (JSON.stringify(policy) !== JSON.stringify(quote.policy))
      deny('policy_changed');
    await this.advertiser(input, quote.advertiserId, db);
    if ((await this.host.validateQuote(quote, db)) !== true)
      deny('quote_unavailable');
    if (
      quote.approval?.status === 'approved' &&
      quote.approval.checkerProfileId
    ) {
      const checker = {
        tenantId: input.tenantId,
        actorProfileId: quote.approval.checkerProfileId,
      };
      await this.context(checker, db);
      if ((await this.host.canApprove(checker, db)) !== true)
        deny('finance_unauthorized');
    }
  }

  private async quote(
    input: Omit<SalesQuoteOperation, 'operationId'>,
    deps: Deps,
  ): Promise<[SalesGovernanceState, SalesQuoteSnapshot]> {
    text(input.quoteId);
    integer(input.revision, 1);
    const head = await deps.states.lock(
      key('quote-head', input.tenantId, input.quoteId),
    );
    if (parse<{ revision: number }>(head.payload)?.revision !== input.revision)
      deny('stale_quote_revision');
    const state = await deps.states.lock(
      quoteKey(input.tenantId, input.quoteId, input.revision),
    );
    const quote = parse<SalesQuoteSnapshot>(state.payload);
    if (!quote || quote.tenantId !== input.tenantId) deny('quote_unavailable');
    return [state, quote];
  }

  private async seller(
    input: SellerContext,
    sellerId: string,
    deps: Deps,
    db: DatabaseInterface,
  ): Promise<SellerPolicy> {
    await this.context(input, db);
    text(sellerId);
    const rows = await deps.reps.query(
      `UPDATE ${deps.reps.tableName} SET status = status WHERE id = ? AND tenant_id = ? AND profile_id = ? AND status = 'active' RETURNING id`,
      [sellerId, input.tenantId, input.actorProfileId],
      { allowRawOnTenantScoped: true },
    );
    if (rows.length !== 1) deny('seller_unauthorized');
    const context = { ...input, sellerId };
    if ((await this.host.canSell(context, db)) !== true)
      deny('seller_policy_denied');
    const policy = await this.host.policy(context, db);
    if (!policy || typeof policy !== 'object') deny('invalid_policy');
    text(policy.version);
    integer(policy.maxDiscountBps, 0, 10000);
    integer(policy.leaseDurationMs, 1);
    integer(policy.approvalDurationMs, 1);
    return {
      version: policy.version,
      maxDiscountBps: policy.maxDiscountBps,
      leaseDurationMs: policy.leaseDurationMs,
      approvalDurationMs: policy.approvalDurationMs,
    };
  }

  private async context(
    input: SellerContext,
    db: DatabaseInterface,
  ): Promise<void> {
    this.assertBackend();
    this.assertContext(input);
    if ((await this.host.isMember(input, db)) !== true)
      deny('membership_required');
    if ((await this.host.isUnsuspended(input, db)) !== true) deny('suspended');
  }
  private async advertiser(
    input: SellerContext,
    advertiserId: string,
    db: DatabaseInterface,
  ): Promise<void> {
    text(advertiserId);
    if (
      (await this.host.advertiserExists({ ...input, advertiserId }, db)) !==
      true
    )
      deny('advertiser_unavailable');
  }
  private assertContext(input: SellerContext): void {
    text(input.tenantId);
    text(input.actorProfileId);
    if (requireTenantId() !== input.tenantId) deny('tenant_context_mismatch');
  }
  private time(): number {
    const now = this.now().getTime();
    integer(now, 0);
    return now;
  }
  private async store(
    deps: Deps,
    state: SalesGovernanceState,
    value: unknown,
  ): Promise<void> {
    if (
      !(await deps.states.compareAndSwap(
        state.id!,
        state.revision,
        JSON.stringify(value),
      ))
    )
      deny('concurrent_change_retry');
  }
  private async operation<T>(
    kind: string,
    input: SellerOperation,
    tx: DatabaseInterface | undefined,
    fn: (deps: Deps, db: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    this.assertBackend();
    this.assertContext(input);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        input.operationId,
      )
    )
      deny('invalid_operation_id');
    const intent = canonical({ kind, input });
    return this.run(tx, async (deps, db) => {
      await deps.states.lock(key('operation', input.operationId));
      const previous = await deps.events.get(
        { id: input.operationId },
        { cache: false },
      );
      if (previous) {
        if (previous.intent !== intent) deny('replay_conflict');
        // Replays return historical evidence, never a fresh transition authority.
        return JSON.parse(previous.result) as T;
      }
      const result = await fn(deps, db);
      await deps.events.create({
        id: input.operationId,
        slug: input.operationId,
        tenantId: input.tenantId,
        intent,
        result: JSON.stringify(result),
      });
      return result;
    });
  }
  private assertBackend(): void {
    if (this.#backend !== 'postgres') deny('unsupported_backend');
  }

  private async run<T>(
    tx: DatabaseInterface | undefined,
    fn: (deps: Deps, db: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    this.assertBackend();
    const execute = async (db: DatabaseInterface) =>
      withGovernanceWrite(db, async () =>
        fn(
          {
            states: await SalesGovernanceStateCollection.create({ db }),
            events: await SalesGovernanceEventCollection.create({ db }),
            reps: await SalesRepresentativeCollection.create({ db }),
          },
          db,
        ),
      );
    if (tx) {
      if (!ownedTransactions.has(tx)) deny('transaction_executor_required');
      return execute(tx);
    }
    const db = this.database as TransactionDatabase;
    if (typeof db.transaction !== 'function') deny('transaction_unavailable');
    return db.transaction(execute);
  }
}

function deny(reason: string): never {
  throw new SalesGovernanceError(reason);
}
function text(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    deny('invalid_identity');
}
function integer(
  value: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    deny('invalid_numeric_value');
}
function expiry(now: number, duration: number): number {
  const value = now + duration;
  integer(value, 0);
  return value;
}
function parse<T>(payload: string): T | null {
  return payload === '{}' ? null : (JSON.parse(payload) as T);
}
function key(...parts: Array<string | number>): string {
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function quoteKey(tenant: string, quote: string, revision: number): string {
  return key('quote', tenant, quote, revision);
}
function validateTerms(terms: SalesQuoteTerms): void {
  if (!terms) deny('invalid_quote');
  for (const value of [
    terms.quoteId,
    terms.sellerId,
    terms.advertiserId,
    terms.rateCardVersion,
    terms.inventoryVersion,
  ])
    text(value);
  integer(terms.revision, 1);
  integer(terms.subtotalCents, 0);
  integer(terms.totalCents, 0, terms.subtotalCents);
  if (!/^[A-Z]{3}$/.test(terms.currency)) deny('invalid_currency');
}
function termsHash(quote: SalesQuoteSnapshot): string {
  const { status: _status, approval: _approval, ...terms } = quote;
  return createHash('sha256').update(canonical(terms)).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
    )
    .join(',')}}`;
}

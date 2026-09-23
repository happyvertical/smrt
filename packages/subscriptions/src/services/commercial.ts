import {
  type DatabaseConfig,
  isDatabaseInterface,
  isEmbeddedDatabase,
  type SmrtClassOptions,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import {
  type BillingRelationshipService,
  type BillingRelationshipView,
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import type { SqlAdapterType } from '@happyvertical/sql';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import {
  BillingAdjustmentCollection,
  type ClientCharge,
  ClientChargeCollection,
  type PricingRule,
  PricingRuleCollection,
  type PricingStrategy,
  type SpendingBasis,
  type SpendingPolicy,
  SpendingPolicyCollection,
} from '../models/commercial.js';
import {
  type CreditGrant,
  CreditGrantCollection,
  type PriceBook,
  PriceBookAssignmentCollection,
  PriceBookCollection,
  type PriceBookKind,
  type RetailCharge,
  RetailChargeCollection,
} from '../models/reseller.js';
import type { TenantUsageMetric } from '../models/TenantUsageMetric.js';
import type { RecordUsageOptions, SubscriberKind } from '../types.js';
import {
  deterministicUuid,
  normalizeSubscriber,
  subscriberToColumns,
  tenantKey,
} from '../utils.js';
import { ResellerBillingError } from './reseller-errors.js';

export interface PriceUsageOptions {
  usageEventId: string;
  approved?: boolean;
  at?: Date;
}

/** The released smrt-tenancy billing-owner read this package depends on. */
export type BillingRelationshipReader = Pick<
  BillingRelationshipService,
  'getRelationship'
>;

export interface RateUsageOptions extends PriceUsageOptions {
  /** Resolves the usage tenant's reseller relationship and billing owner. */
  billingRelationships: BillingRelationshipReader;
}

/**
 * The outcome of rating one usage event (#3059). A usage event is rated
 * exactly once: the first rating fixes the payer and price books, and later
 * calls return the same records even if the billing owner has since changed.
 */
export interface UsageRating {
  /** The tenant that produced the usage. */
  usageTenantId: string;
  /** Who pays the provider: the usage tenant, or its reseller. */
  billingOwnerTenantId: string;
  /** `direct` for self-billed usage, `wholesale` for reseller-billed usage. */
  mode: 'direct' | 'wholesale';
  /** The provider's charge, payable by {@link billingOwnerTenantId}. */
  charge: ClientCharge;
  /** The reseller's retail charge to the child, when a retail book applies. */
  retailCharge: RetailCharge | null;
}
export interface CustomPricingContext {
  usage: { quantity: number; dimensions: Record<string, unknown> };
  rule: PricingRule;
  terms: Record<string, unknown>;
}
export type CustomPricingStrategy = (
  context: CustomPricingContext,
) => number | Promise<number>;

export interface CommercialBillingStorage {
  adapterType: SqlAdapterType;
  writeStrategy?: 'immediate' | 'manual' | 'none';
}

export interface CommercialUsageServiceOptions extends SmrtClassOptions {
  /**
   * Required when `db` is an already-resolved database handle, whose public
   * interface does not expose its adapter/write-back configuration.
   */
  billingStorage?: CommercialBillingStorage;
}

const embeddedAdjustmentLocks = new Map<string | object, Promise<void>>();

async function withEmbeddedSourcedAdjustmentLock<T>(
  db: { url?: string },
  storage: CommercialBillingStorage,
  sourced: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (!sourced || storage.adapterType === 'postgres') return operation();

  const key = db.url ? `${storage.adapterType}:${db.url}` : (db as object);
  const previous = embeddedAdjustmentLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  embeddedAdjustmentLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (embeddedAdjustmentLocks.get(key) === queued) {
      embeddedAdjustmentLocks.delete(key);
    }
  }
}

export class UnsupportedCommercialBillingStorageError extends Error {
  readonly code = 'UNSUPPORTED_COMMERCIAL_BILLING_STORAGE';

  constructor(storage: CommercialBillingStorage) {
    super(
      `Commercial billing does not support ${storage.adapterType} ` +
        `with immediate JSON write-back because exported files are not ` +
        `transactionally rolled back. Use PostgreSQL, SQLite, ordinary ` +
        `DuckDB, or a non-immediate write strategy.`,
    );
    this.name = 'UnsupportedCommercialBillingStorageError';
  }
}

export class CommercialBillingStorageConfigurationError extends Error {
  readonly code = 'COMMERCIAL_BILLING_STORAGE_CONFIGURATION_REQUIRED';

  constructor(message?: string) {
    super(
      message ??
        'Commercial billing requires billingStorage when db is an already-resolved handle because adapter write-back capabilities are not public on that interface.',
    );
    this.name = 'CommercialBillingStorageConfigurationError';
  }
}

function assertValidCommercialBillingWriteStrategy(
  writeStrategy: unknown,
): asserts writeStrategy is CommercialBillingStorage['writeStrategy'] {
  if (
    writeStrategy !== undefined &&
    writeStrategy !== 'immediate' &&
    writeStrategy !== 'manual' &&
    writeStrategy !== 'none'
  ) {
    throw new CommercialBillingStorageConfigurationError(
      'Commercial billing database writeStrategy must be immediate, manual, or none.',
    );
  }
}

function snapshotCommercialBillingStorage(
  storage: CommercialBillingStorage,
): CommercialBillingStorage {
  const adapterType: unknown = storage.adapterType;
  if (
    adapterType !== 'sqlite' &&
    adapterType !== 'postgres' &&
    adapterType !== 'duckdb' &&
    adapterType !== 'json'
  ) {
    throw new CommercialBillingStorageConfigurationError(
      'Commercial billing storage adapterType must be sqlite, postgres, duckdb, or json.',
    );
  }
  const writeStrategy: unknown = storage.writeStrategy;
  assertValidCommercialBillingWriteStrategy(writeStrategy);
  return { adapterType, writeStrategy };
}

function snapshotCommercialUsageServiceOptions(
  options: CommercialUsageServiceOptions,
): CommercialUsageServiceOptions {
  const snapshot = { ...options };
  if (snapshot.billingStorage) {
    snapshot.billingStorage = snapshotCommercialBillingStorage(
      snapshot.billingStorage,
    );
  }
  for (const key of ['db', 'persistence'] as const) {
    const database = snapshot[key];
    if (
      database &&
      typeof database !== 'string' &&
      !isDatabaseInterface(database)
    ) {
      snapshot[key] = { ...database };
    }
  }
  return snapshot;
}

export function assertCommercialBillingStorageSupported(
  storage: CommercialBillingStorage,
): void {
  const snapshot = snapshotCommercialBillingStorage(storage);
  const writeStrategy =
    snapshot.adapterType === 'json'
      ? (snapshot.writeStrategy ?? 'immediate')
      : snapshot.writeStrategy;
  if (
    (snapshot.adapterType === 'json' || snapshot.adapterType === 'duckdb') &&
    writeStrategy === 'immediate'
  ) {
    throw new UnsupportedCommercialBillingStorageError({
      ...snapshot,
      writeStrategy,
    });
  }
}

function inferAdapterType(url: string): SqlAdapterType | undefined {
  if (/^postgres(?:ql)?:/iu.test(url)) return 'postgres';
  if (/^(?:https?|libsql):\/\//iu.test(url)) return 'sqlite';
  if (/\.duckdb(?:$|\?)/iu.test(url)) return 'duckdb';
  if (url === ':memory:' || url.startsWith('file:')) return 'sqlite';
  return undefined;
}

function environmentAdapterType(): SqlAdapterType | undefined {
  const type = process.env.HAVE_SQL_TYPE;
  if (type === undefined || type === '') return undefined;
  if (
    type === 'sqlite' ||
    type === 'postgres' ||
    type === 'duckdb' ||
    type === 'json'
  ) {
    return type;
  }
  throw new CommercialBillingStorageConfigurationError(
    'Commercial billing HAVE_SQL_TYPE must be sqlite, postgres, duckdb, or json.',
  );
}

function environmentWriteStrategy(): CommercialBillingStorage['writeStrategy'] {
  const strategy = process.env.HAVE_SQL_WRITE_STRATEGY;
  if (strategy === undefined || strategy === '') return undefined;
  if (
    strategy === 'immediate' ||
    strategy === 'manual' ||
    strategy === 'none'
  ) {
    return strategy;
  }
  throw new CommercialBillingStorageConfigurationError(
    'Commercial billing HAVE_SQL_WRITE_STRATEGY must be immediate, manual, or none.',
  );
}

function billingStorageFromConfig(
  config: DatabaseConfig | undefined,
  declared?: CommercialBillingStorage,
): CommercialBillingStorage {
  // Validate a configured environment value even when an explicit config type
  // wins adapter precedence. Otherwise normalization below could hide an SDK
  // configuration error by replacing the invalid environment value.
  const environmentType = environmentAdapterType();
  if (config === undefined) {
    if (environmentType)
      return {
        adapterType: environmentType,
        writeStrategy: environmentWriteStrategy(),
      };
    return { adapterType: 'sqlite' };
  }
  if (isDatabaseInterface(config)) {
    throw new CommercialBillingStorageConfigurationError();
  }
  if (typeof config === 'string') {
    const adapterType =
      environmentType ?? inferAdapterType(config) ?? declared?.adapterType;
    if (adapterType)
      return {
        adapterType,
        writeStrategy: environmentWriteStrategy() ?? declared?.writeStrategy,
      };
    throw new Error(
      'Commercial billing requires an explicit billingStorage adapter contract for ambiguous database URLs.',
    );
  }
  const adapterType =
    config.type ??
    environmentType ??
    inferAdapterType(String(config.url ?? '')) ??
    declared?.adapterType;
  if (!adapterType) {
    throw new Error(
      'Commercial billing requires an explicit database type or billingStorage adapter contract.',
    );
  }
  const configuredWriteStrategy = config.writeStrategy;
  assertValidCommercialBillingWriteStrategy(configuredWriteStrategy);
  const writeStrategy =
    configuredWriteStrategy === 'immediate' ||
    configuredWriteStrategy === 'manual' ||
    configuredWriteStrategy === 'none'
      ? configuredWriteStrategy
      : (environmentWriteStrategy() ?? declared?.writeStrategy);
  return { adapterType, writeStrategy };
}

function effectiveWriteStrategy(
  storage: CommercialBillingStorage,
): CommercialBillingStorage['writeStrategy'] {
  if (storage.writeStrategy) return storage.writeStrategy;
  if (storage.adapterType === 'json') return 'immediate';
  if (storage.adapterType === 'duckdb') return 'none';
  return undefined;
}

function resolveCommercialBillingStorage(
  options: CommercialUsageServiceOptions,
): CommercialBillingStorage {
  // Environment declarations are configuration contracts, even when explicit
  // options win precedence. Reject invalid nonempty values before setup.
  environmentAdapterType();
  environmentWriteStrategy();
  const configuredDatabase = options.db ?? options.persistence;
  if (isDatabaseInterface(configuredDatabase)) {
    if (!options.billingStorage) {
      throw new CommercialBillingStorageConfigurationError();
    }
    return options.billingStorage;
  }
  const configured = billingStorageFromConfig(
    configuredDatabase,
    options.billingStorage,
  );
  if (
    options.billingStorage &&
    (options.billingStorage.adapterType !== configured.adapterType ||
      effectiveWriteStrategy(options.billingStorage) !==
        effectiveWriteStrategy(configured))
  ) {
    throw new CommercialBillingStorageConfigurationError(
      'Commercial billingStorage must match the configured database adapter and write strategy.',
    );
  }
  return configured;
}

function normalizedCommercialClassOptions(
  options: CommercialUsageServiceOptions,
  billingStorage: CommercialBillingStorage,
): SmrtClassOptions {
  const { billingStorage: _billingStorage, ...classOptions } = options;
  const configuredDatabase = options.db ?? options.persistence;
  if (configuredDatabase && !isDatabaseInterface(configuredDatabase)) {
    const normalizedDatabase =
      typeof configuredDatabase === 'string'
        ? {
            type: billingStorage.adapterType,
            url: configuredDatabase,
            writeStrategy: billingStorage.writeStrategy,
          }
        : {
            ...configuredDatabase,
            type: billingStorage.adapterType,
            writeStrategy: billingStorage.writeStrategy,
          };
    if (options.db !== undefined) classOptions.db = normalizedDatabase;
    else classOptions.persistence = normalizedDatabase;
  }
  return classOptions;
}

interface ResellerCollections {
  books: PriceBookCollection;
  assignments: PriceBookAssignmentCollection;
  retailCharges: RetailChargeCollection;
}

export class CommercialUsageService {
  private readonly customStrategies = new Map<string, CustomPricingStrategy>();
  private resellerCollections?: Promise<ResellerCollections>;
  constructor(
    private readonly usage: TenantUsageMetricCollection,
    private readonly rules: PricingRuleCollection,
    private readonly charges: ClientChargeCollection,
    private readonly adjustments: BillingAdjustmentCollection,
    private readonly billingStorage: CommercialBillingStorage,
  ) {
    if (!billingStorage) {
      throw new CommercialBillingStorageConfigurationError();
    }
    assertCommercialBillingStorageSupported(billingStorage);
  }

  static async create(
    options: CommercialUsageServiceOptions = {},
  ): Promise<CommercialUsageService> {
    const optionSnapshot = snapshotCommercialUsageServiceOptions(options);
    const billingStorage = resolveCommercialBillingStorage(optionSnapshot);
    assertCommercialBillingStorageSupported(billingStorage);
    const classOptions = normalizedCommercialClassOptions(
      optionSnapshot,
      billingStorage,
    );
    const usage = await TenantUsageMetricCollection.create(classOptions);
    const sharedOptions = { ...classOptions, db: usage.db };
    return new CommercialUsageService(
      usage,
      await PricingRuleCollection.create(sharedOptions),
      await ClientChargeCollection.create(sharedOptions),
      await BillingAdjustmentCollection.create(sharedOptions),
      billingStorage,
    );
  }

  registerCustomStrategy(key: string, strategy: CustomPricingStrategy): void {
    this.customStrategies.set(key, strategy);
  }

  async record(options: RecordUsageOptions) {
    return this.usage.recordUsage(options);
  }

  async price(options: PriceUsageOptions): Promise<ClientCharge> {
    const existing = await this.charges.list({
      where: { usageEventId: options.usageEventId },
      limit: 1,
    });
    if (existing[0]) {
      return this.approveCharge(existing[0], options.approved);
    }
    const usage = await this.usage.get(options.usageEventId);
    if (!usage)
      throw new Error(`Usage event ${options.usageEventId} was not found.`);
    const at = options.at ?? usage.windowStart;
    const dimensions = usage.getDimensions();
    const rules = await this.rules.list({
      where: {
        tenantId: usage.tenantId,
        metricKey: usage.metricKey,
        active: true,
      },
    });
    // Price-book rules are published by a seller for rateUsage(); they are
    // never a tenant's own direct pricing.
    const rule = selectRule(
      rules.filter((candidate) => !candidate.priceBookId),
      at,
      String(dimensions.serviceKey ?? ''),
    );
    if (!rule)
      throw new Error(
        `No effective pricing rule for metric '${usage.metricKey}'.`,
      );
    if (!usage.id)
      throw new Error(
        `Usage event ${options.usageEventId} has no persisted id.`,
      );
    if (!rule.id)
      throw new Error(`Pricing rule '${rule.ruleKey}' has no persisted id.`);
    const amount = await this.calculateAmount(rule, usage.quantity, dimensions);
    const chargeId = await deterministicUuid([
      'client-charge',
      String(usage.tenantId),
      String(usage.id),
    ]);
    try {
      return await this.charges.create({
        id: chargeId,
        tenantId: usage.tenantId,
        usageEventId: String(usage.id),
        usageTenantId: usage.tenantId,
        subscriberKind: usage.subscriberKind,
        subscriberExternalId: usage.subscriberExternalId,
        projectId: usage.projectId,
        workRefType: usage.workRefType,
        workRefId: usage.workRefId,
        provider: usage.provider,
        serviceKey: String(dimensions.serviceKey ?? ''),
        metricKey: usage.metricKey,
        quantity: usage.quantity,
        amount,
        currency: rule.currency,
        pricingRuleId: String(rule.id),
        pricingSnapshot: JSON.stringify({
          ruleKey: rule.ruleKey,
          strategy: rule.strategy,
          terms: rule.getTerms(),
          effectiveFrom: rule.effectiveFrom,
        }),
        status: options.approved ? 'approved' : 'draft',
        approvedAt: options.approved ? new Date() : null,
        _insertOnly: true,
      });
    } catch (error) {
      const concurrent = await this.charges.get(chargeId);
      if (!concurrent) throw error;
      return this.approveCharge(concurrent, options.approved);
    }
  }

  /**
   * Rate one usage event under its billing owner's price books (#3059).
   *
   * - No reseller relationship, or a `self`-billed one: the usage tenant pays
   *   the provider directly, priced exactly as {@link price} prices it.
   * - `reseller`-billed: the reseller pays the provider from the child's
   *   assigned wholesale book (a {@link ClientCharge} with `tenantId` = the
   *   reseller and `usageTenantId` = the child) and, when the child has a
   *   retail book assigned, the child owes the reseller a
   *   {@link RetailCharge}. Both records commit in one transaction.
   *
   * Rating is idempotent per usage event and frozen at first rating: a later
   * billing-owner change never re-prices or double-charges an event that
   * already has a provider charge, because `ClientCharge` holds exactly one
   * row per usage event.
   *
   * Rating reads the seller's books across tenants; run it where the host's
   * tenancy rules allow that (typically a system context).
   */
  async rateUsage(options: RateUsageOptions): Promise<UsageRating> {
    const { retailCharges } = await this.getResellerCollections();
    const existing = await this.charges.list({
      where: { usageEventId: options.usageEventId },
      limit: 1,
    });
    if (existing[0]) {
      return this.frozenRating(existing[0], retailCharges, options.approved);
    }
    const usage = await this.usage.get(options.usageEventId);
    if (!usage)
      throw new Error(`Usage event ${options.usageEventId} was not found.`);
    if (!usage.id || !usage.tenantId)
      throw new Error(
        `Usage event ${options.usageEventId} has no persisted tenant id.`,
      );
    const relationship = await options.billingRelationships.getRelationship(
      usage.tenantId,
    );
    if (relationship?.billingOwnerMode !== 'reseller') {
      const charge = await this.price(options);
      return this.frozenRating(charge, retailCharges, options.approved);
    }
    try {
      return await this.rateResellerBilled(usage, relationship, options);
    } catch (error) {
      // A concurrent rating of the same event won the one-row-per-event
      // insert; its transaction wrote the complete rating.
      const concurrent = await this.charges.list({
        where: { usageEventId: String(usage.id) },
        limit: 1,
      });
      if (!concurrent[0]) throw error;
      return this.frozenRating(concurrent[0], retailCharges, options.approved);
    }
  }

  private async rateResellerBilled(
    usage: TenantUsageMetric,
    relationship: BillingRelationshipView,
    options: RateUsageOptions,
  ): Promise<UsageRating> {
    const { books, assignments } = await this.getResellerCollections();
    const childTenantId = relationship.childTenantId;
    const resellerTenantId = relationship.resellerTenantId;
    const assignment = await assignments.get({ childTenantId });
    if (
      !assignment?.wholesalePriceBookId ||
      tenantKey(assignment.resellerTenantId) !== resellerTenantId
    ) {
      throw new ResellerBillingError(
        `No wholesale price book is assigned to tenant ${childTenantId} under reseller ${resellerTenantId}.`,
        'PRICE_BOOK_NOT_ASSIGNED',
      );
    }
    const at = options.at ?? usage.windowStart;
    const dimensions = usage.getDimensions();
    const serviceKey = String(dimensions.serviceKey ?? '');
    const wholesaleBook = await loadBook(
      books,
      assignment.wholesalePriceBookId,
      'wholesale',
    );
    assertWholesalePublisher(wholesaleBook, resellerTenantId, childTenantId);
    const wholesaleRule = await this.selectBookRule(
      wholesaleBook,
      usage.metricKey,
      serviceKey,
      assignment.wholesaleCurrency,
      at,
    );
    let retail: { book: PriceBook; rule: PricingRule } | null = null;
    if (assignment.retailPriceBookId) {
      const retailBook = await loadBook(
        books,
        assignment.retailPriceBookId,
        'retail',
      );
      if (tenantKey(retailBook.tenantId) !== resellerTenantId) {
        throw new ResellerBillingError(
          `Retail price book '${retailBook.bookKey}' is not published by reseller ${resellerTenantId}.`,
          'PRICE_BOOK_OWNER_MISMATCH',
        );
      }
      retail = {
        book: retailBook,
        rule: await this.selectBookRule(
          retailBook,
          usage.metricKey,
          serviceKey,
          assignment.retailCurrency,
          at,
        ),
      };
    }
    const wholesaleAmount = await this.calculateAmount(
      wholesaleRule,
      usage.quantity,
      dimensions,
    );
    const retailAmount = retail
      ? await this.calculateAmount(retail.rule, usage.quantity, dimensions)
      : 0;
    const usageEventId = String(usage.id);
    const chargeId = await deterministicUuid([
      'client-charge',
      String(usage.tenantId),
      usageEventId,
    ]);
    const retailChargeId = await deterministicUuid([
      'retail-charge',
      String(usage.tenantId),
      usageEventId,
    ]);
    const approvedAt = options.approved ? new Date() : null;
    const status = options.approved ? 'approved' : 'draft';
    const usageColumns = {
      usageEventId,
      subscriberKind: usage.subscriberKind,
      subscriberExternalId: usage.subscriberExternalId,
      projectId: usage.projectId,
      workRefType: usage.workRefType,
      workRefId: usage.workRefId,
      provider: usage.provider,
      serviceKey,
      metricKey: usage.metricKey,
      quantity: usage.quantity,
    };
    const snapshot = (book: PriceBook, rule: PricingRule) =>
      JSON.stringify({
        ruleKey: rule.ruleKey,
        strategy: rule.strategy,
        terms: rule.getTerms(),
        effectiveFrom: rule.effectiveFrom,
        priceBookKey: book.bookKey,
        priceBookKind: book.kind,
        usageTenantId: childTenantId,
        billingOwnerTenantId: resellerTenantId,
      });
    const db = this.charges.db;
    return withEmbeddedWriteTransaction(
      db,
      isEmbeddedDatabase(db),
      async (transaction) => {
        const charges = await ClientChargeCollection.create({
          db: transaction,
        });
        const retailCharges = await RetailChargeCollection.create({
          db: transaction,
        });
        const charge = await charges.create({
          id: chargeId,
          tenantId: resellerTenantId,
          usageTenantId: childTenantId,
          ...usageColumns,
          amount: wholesaleAmount,
          currency: wholesaleRule.currency,
          pricingRuleId: String(wholesaleRule.id),
          priceBookId: String(wholesaleBook.id),
          pricingSnapshot: snapshot(wholesaleBook, wholesaleRule),
          status,
          approvedAt,
          _insertOnly: true,
        });
        const retailCharge = retail
          ? await retailCharges.create({
              id: retailChargeId,
              tenantId: childTenantId,
              resellerTenantId,
              clientChargeId: chargeId,
              ...usageColumns,
              amount: retailAmount,
              currency: retail.rule.currency,
              priceBookId: String(retail.book.id),
              pricingRuleId: String(retail.rule.id),
              pricingSnapshot: snapshot(retail.book, retail.rule),
              status,
              approvedAt,
              _insertOnly: true,
            })
          : null;
        return {
          usageTenantId: childTenantId,
          billingOwnerTenantId: resellerTenantId,
          mode: 'wholesale' as const,
          charge,
          retailCharge,
        };
      },
    );
  }

  private async selectBookRule(
    book: PriceBook,
    metricKey: string,
    serviceKey: string,
    currency: string,
    at: Date,
  ): Promise<PricingRule> {
    const rules = await this.rules.list({
      where: {
        tenantId: book.tenantId,
        priceBookId: book.id,
        metricKey,
        currency,
        active: true,
      },
    });
    const rule = selectRule(
      // The owner check keeps a rule filed under someone else's book (the
      // rules API is tenant-writable) from pricing that book.
      rules.filter(
        (candidate) =>
          candidate.priceBookId === book.id &&
          candidate.tenantId === book.tenantId &&
          candidate.currency === currency,
      ),
      at,
      serviceKey,
    );
    if (!rule?.id) {
      throw new ResellerBillingError(
        `Price book '${book.bookKey}' has no effective ${currency} price for metric '${metricKey}'.`,
        'NO_EFFECTIVE_PRICE',
      );
    }
    return rule;
  }

  private async frozenRating(
    charge: ClientCharge,
    retailCharges: RetailChargeCollection,
    approved = false,
  ): Promise<UsageRating> {
    const retail = await retailCharges.list({
      where: { usageEventId: charge.usageEventId },
      limit: 1,
    });
    let providerCharge = charge;
    let retailCharge: RetailCharge | null = retail[0] ?? null;
    if (
      approved &&
      (providerCharge.status === 'draft' || retailCharge?.status === 'draft')
    ) {
      // Approve both legs in one transaction so they never disagree.
      const db = this.charges.db;
      [providerCharge, retailCharge] = await withEmbeddedWriteTransaction(
        db,
        isEmbeddedDatabase(db),
        async (transaction) => {
          const charges = await ClientChargeCollection.create({
            db: transaction,
          });
          const retails = await RetailChargeCollection.create({
            db: transaction,
          });
          const provider = await charges.get(String(charge.id));
          if (!provider) {
            throw new Error(`Client charge ${charge.id} was not found.`);
          }
          const leg = retailCharge
            ? await retails.get(String(retailCharge.id))
            : null;
          const approvedAt = new Date();
          if (provider.status === 'draft') {
            provider.status = 'approved';
            provider.approvedAt = approvedAt;
            await provider.save();
          }
          if (leg?.status === 'draft') {
            leg.status = 'approved';
            leg.approvedAt = approvedAt;
            await leg.save();
          }
          return [provider, leg ?? null] as const;
        },
      );
    }
    return {
      usageTenantId:
        tenantKey(providerCharge.usageTenantId) ||
        tenantKey(providerCharge.tenantId),
      billingOwnerTenantId: tenantKey(providerCharge.tenantId),
      mode: providerCharge.priceBookId ? 'wholesale' : 'direct',
      charge: providerCharge,
      retailCharge,
    };
  }

  private getResellerCollections(): Promise<ResellerCollections> {
    this.resellerCollections ??= (async () => {
      const options = { db: this.charges.db };
      return {
        books: await PriceBookCollection.create(options),
        assignments: await PriceBookAssignmentCollection.create(options),
        retailCharges: await RetailChargeCollection.create(options),
      };
    })();
    this.resellerCollections.catch(() => {
      this.resellerCollections = undefined;
    });
    return this.resellerCollections;
  }

  private async approveCharge(
    charge: ClientCharge,
    approved = false,
  ): Promise<ClientCharge> {
    if (approved && charge.status === 'draft') {
      charge.status = 'approved';
      charge.approvedAt = new Date();
      await charge.save();
    }
    return charge;
  }

  /**
   * Append a signed correction to an approved charge.
   *
   * @param amount - Signed correction in **integer minor units**, same unit as
   *   the charge (#2401). Negative is legitimate — that is a credit. A
   *   fractional value is rejected rather than silently rounded, because it
   *   almost always means the caller passed major units.
   */
  async adjust(
    chargeId: string,
    amount: number,
    reason: string,
    source = '',
    sourceId = '',
  ) {
    if (!Number.isInteger(amount)) {
      throw new Error(
        `Billing adjustment amount must be an integer number of minor units ` +
          `(cents) — got ${amount}. Money is exact: -$0.25 is -25, not -0.25.`,
      );
    }
    const sourced = Boolean(source && sourceId);
    return withEmbeddedSourcedAdjustmentLock(
      this.charges.db,
      this.billingStorage,
      sourced,
      () => this.adjustWithinLock(chargeId, amount, reason, source, sourceId),
    );
  }

  private async adjustWithinLock(
    chargeId: string,
    amount: number,
    reason: string,
    source: string,
    sourceId: string,
  ) {
    const initialCharge = await this.charges.get(chargeId);
    if (!initialCharge)
      throw new Error(`Client charge ${chargeId} was not found.`);
    if (
      initialCharge.status !== 'approved' &&
      initialCharge.status !== 'adjusted'
    ) {
      throw new Error(
        `Client charge ${chargeId} must be approved before it can be adjusted.`,
      );
    }
    const sourcedId =
      source && sourceId
        ? await deterministicUuid([
            'billing-adjustment',
            String(initialCharge.tenantId),
            chargeId,
            source,
            sourceId,
          ])
        : null;
    const db = this.charges.db;
    if (!db.transaction) {
      throw new Error('Atomic billing adjustment requires transaction support');
    }
    try {
      return await withEmbeddedWriteTransaction(
        db,
        isEmbeddedDatabase(db),
        async (transaction) => {
          const options = { db: transaction };
          const charges = await ClientChargeCollection.create(options);
          const adjustments = await BillingAdjustmentCollection.create(options);
          const charge = await charges.get(chargeId);
          if (!charge)
            throw new Error(`Client charge ${chargeId} was not found.`);
          if (charge.status !== 'approved' && charge.status !== 'adjusted') {
            throw new Error(
              `Client charge ${chargeId} must be approved before it can be adjusted.`,
            );
          }
          let adjustment = sourcedId
            ? await adjustments.get(sourcedId)
            : undefined;
          if (!adjustment) {
            adjustment = await adjustments.create({
              ...(sourcedId ? { id: sourcedId } : {}),
              tenantId: charge.tenantId,
              clientChargeId: chargeId,
              amount,
              currency: charge.currency,
              reason,
              source,
              sourceId,
              _insertOnly: Boolean(sourcedId),
            });
          }
          if (charge.status === 'approved') {
            charge.status = 'adjusted';
            await charge.save();
          }
          return adjustment;
        },
      );
    } catch (error) {
      // A concurrent sourced adjustment may win the deterministic insert. Its
      // transaction also owns the charge-state transition, so it is safe to
      // return only after both durable records are visible.
      if (sourcedId) {
        // Embedded adapters multiplex one native handle. Keep recovery reads
        // sequential just like the transaction flow protected above.
        const adjustment = await this.adjustments.get(sourcedId);
        const charge = await this.charges.get(chargeId);
        if (adjustment && charge?.status === 'adjusted') return adjustment;
      }
      throw error;
    }
  }

  /**
   * Price one usage event, in **integer minor units** (#2401).
   *
   * The pricing terms stay fractional on purpose — a per-token rate is
   * routinely a fraction of a cent, and an integer `unitPrice` would truncate
   * it to zero — so terms are read as *minor units per unit of usage* and only
   * the result is rounded. This is the single boundary in the package where a
   * rate meets money, which is what lets `evaluateSpending()` compare sums
   * against `SpendingPolicy.limitAmount` exactly.
   *
   * Replaces the old micro-unit rounding (`Math.round(amount * 1e6) / 1e6`),
   * which kept six sub-cent digits in a column that is now integral.
   */
  async calculateAmount(
    rule: PricingRule,
    quantity: number,
    dimensions: Record<string, unknown> = {},
  ): Promise<number> {
    const terms = rule.getTerms();
    const number = (key: string, fallback = 0) =>
      Number(terms[key] ?? fallback);
    let amount: number;
    switch (rule.strategy as PricingStrategy) {
      case 'fixed_unit':
        amount = quantity * number('unitPrice');
        break;
      case 'cost_plus':
        amount =
          Number(dimensions.providerCost ?? 0) +
          number('fixedMarkup') +
          Number(dimensions.providerCost ?? 0) * number('markupRatio');
        break;
      case 'multiplier':
        amount =
          Number(dimensions.providerCost ?? quantity) * number('multiplier', 1);
        break;
      case 'flat':
        amount = number('amount');
        break;
      case 'included_overage':
        amount =
          Math.max(0, quantity - number('includedQuantity')) *
          number('overageUnitPrice');
        break;
      case 'tiered':
        amount = priceTiers(
          quantity,
          Array.isArray(terms.tiers) ? terms.tiers : [],
        );
        break;
      case 'custom': {
        const custom = this.customStrategies.get(
          String(terms.strategyKey ?? ''),
        );
        if (!custom)
          throw new Error(
            `Custom pricing strategy '${String(terms.strategyKey ?? '')}' is not registered.`,
          );
        amount = await custom({ usage: { quantity, dimensions }, rule, terms });
        break;
      }
    }
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error('Pricing produced an invalid amount.');
    return Math.round(amount);
  }
}

export interface SpendingDecision {
  allowed: boolean;
  approvalRequired: boolean;
  state: 'ok' | 'observed' | 'warned' | 'blocked' | 'approval_required';
  /**
   * Already-spent plus estimated, in **integer minor units** — the same unit as
   * `SpendingPolicy.limitAmount` it is compared against (#2401).
   */
  projectedAmount: number;
  matchedPolicyId: string | null;
  /**
   * For a prepaid `balance` policy: credit remaining before this estimate
   * (grants minus spend), in integer minor units. Absent for other periods.
   */
  balanceAmount?: number;
}

export interface SpendingEvaluationInput {
  tenantId: string;
  subscriberKind?: SubscriberKind;
  subscriberExternalId?: string;
  projectId?: string;
  serviceKey?: string;
  metricKey: string;
  /** Estimated cost of the pending call, in integer minor units (#2401). */
  estimatedAmount: number;
  /**
   * Per-basis estimates, in integer minor units, for policies whose basis
   * prices the call differently (a retail estimate for `retail` policies, a
   * wholesale estimate for `wholesale` ones). Falls back to
   * {@link estimatedAmount}.
   */
  estimatedAmounts?: Partial<Record<SpendingBasis, number>>;
  currency: string;
  at?: Date;
}

/** Context handed to an {@link AutoTopUpHook} when a balance would run out. */
export interface AutoTopUpRequest {
  policyId: string;
  tenantId: string;
  /** The parent that set the policy, or empty for the tenant's own policy. */
  setByTenantId: string;
  currency: string;
  /** Credit remaining before the estimate, in integer minor units. */
  balanceAmount: number;
  estimatedAmount: number;
  /** How far the estimate overshoots the balance, in integer minor units. */
  shortfall: number;
}

/**
 * A top-up the hook has secured. `sourceId` makes it idempotent: the same
 * `source`/`sourceId` pair is credited once however often it is returned.
 */
export interface AutoTopUpGrant {
  amount: number;
  sourceId: string;
  source?: string;
  reason?: string;
}

/**
 * Host hook for prepaid balances. Called when a pending charge would exhaust a
 * `balance` policy; return a grant to credit it (after the host has secured
 * the funds) or nothing to let the policy's behavior apply. The evaluator
 * never calls a payment provider itself.
 */
export type AutoTopUpHook = (
  request: AutoTopUpRequest,
) =>
  | AutoTopUpGrant
  | null
  | undefined
  | Promise<AutoTopUpGrant | null | undefined>;

export interface SpendingPolicyEvaluatorOptions extends SmrtClassOptions {
  autoTopUp?: AutoTopUpHook;
  /**
   * The smrt-tenancy relationship reader. When supplied, a delegated policy
   * applies only while its `setByTenantId` is the tenant's current reseller;
   * without it every delegated policy applies (fail closed).
   */
  billingRelationships?: BillingRelationshipReader;
}

export interface GrantCreditInput {
  spendingPolicyId: string;
  /** Signed, nonzero credit in integer minor units of the policy currency. */
  amount: number;
  reason?: string;
  /** With `sourceId`, makes the grant idempotent (a payment or order id). */
  source?: string;
  sourceId?: string;
  /** The parent granting credit on its child's delegated policy. */
  grantedByTenantId?: string;
}

export interface SpendingPolicyEvaluatorExtensions {
  retailCharges?: RetailChargeCollection;
  credits?: CreditGrantCollection;
  autoTopUp?: AutoTopUpHook;
  billingRelationships?: BillingRelationshipReader;
}

interface LedgerRow {
  id?: string | null;
  amount: number;
  status: string;
  projectId: string;
  serviceKey: string;
  metricKey: string;
  subscriberKind: string;
  subscriberExternalId: string;
}

export class SpendingPolicyEvaluator {
  private ledgers?: Promise<{
    retailCharges: RetailChargeCollection;
    credits: CreditGrantCollection;
  }>;
  constructor(
    private readonly policies: SpendingPolicyCollection,
    private readonly charges: ClientChargeCollection,
    private readonly adjustments: BillingAdjustmentCollection,
    private readonly extensions: SpendingPolicyEvaluatorExtensions = {},
  ) {}
  static async create(options: SpendingPolicyEvaluatorOptions = {}) {
    const { autoTopUp, billingRelationships, ...classOptions } = options;
    const policies = await SpendingPolicyCollection.create(classOptions);
    const sharedOptions = { ...classOptions, db: policies.db };
    return new SpendingPolicyEvaluator(
      policies,
      await ClientChargeCollection.create(sharedOptions),
      await BillingAdjustmentCollection.create(sharedOptions),
      {
        retailCharges: await RetailChargeCollection.create(sharedOptions),
        credits: await CreditGrantCollection.create(sharedOptions),
        autoTopUp,
        billingRelationships,
      },
    );
  }

  async evaluate(input: SpendingEvaluationInput): Promise<SpendingDecision> {
    const at = input.at ?? new Date();
    const normalizedInput = {
      ...input,
      ...subscriberToColumns(
        normalizeSubscriber({
          tenantId: input.tenantId,
          subscriberKind: input.subscriberKind,
          subscriberExternalId: input.subscriberExternalId,
        }),
      ),
    };
    const candidates = await this.policies.list({
      where: {
        tenantId: input.tenantId,
        currency: input.currency,
        active: true,
      },
    });
    const matchingPolicies = await this.withoutStaleDelegations(
      input.tenantId,
      selectPolicies(candidates, normalizedInput),
    );
    if (matchingPolicies.length === 0)
      return {
        allowed: true,
        approvalRequired: false,
        state: 'ok',
        projectedAmount: input.estimatedAmount,
        matchedPolicyId: null,
      };
    const decisions = await Promise.all(
      matchingPolicies.map((policy) =>
        this.evaluatePolicy(policy, normalizedInput, at),
      ),
    );
    return decisions.reduce((mostRestrictive, decision) =>
      decisionRank(decision) > decisionRank(mostRestrictive)
        ? decision
        : mostRestrictive,
    );
  }

  /**
   * Drop delegated policies whose parent is no longer the tenant's reseller,
   * when a relationship reader is configured.
   */
  private async withoutStaleDelegations(
    tenantId: string,
    policies: SpendingPolicy[],
  ): Promise<SpendingPolicy[]> {
    const reader = this.extensions.billingRelationships;
    if (!reader || !policies.some((policy) => tenantKey(policy.setByTenantId)))
      return policies;
    const relationship = await reader.getRelationship(tenantId);
    const currentParent = tenantKey(relationship?.resellerTenantId);
    return policies.filter((policy) => {
      const setBy = tenantKey(policy.setByTenantId);
      return !setBy || setBy === currentParent;
    });
  }

  /**
   * Credit a prepaid `balance` policy. A delegated policy accepts grants only
   * from the parent that set it (or a system context / super-admin bypass).
   */
  async grantCredit(input: GrantCreditInput): Promise<CreditGrant> {
    const policy = await this.policies.get(input.spendingPolicyId);
    if (!policy?.id) {
      throw new ResellerBillingError(
        `Spending policy ${input.spendingPolicyId} was not found.`,
        'POLICY_NOT_FOUND',
      );
    }
    const setBy = tenantKey(policy.setByTenantId);
    if (
      setBy &&
      !isSystemContext() &&
      !isSuperAdminBypass() &&
      getTenantId()?.toLowerCase() !== setBy
    ) {
      throw new TenantIsolationError(
        'Only the parent that set a delegated policy can grant it credit.',
      );
    }
    if (
      input.grantedByTenantId &&
      setBy &&
      tenantKey(input.grantedByTenantId) !== setBy
    ) {
      throw new TenantIsolationError(
        'Delegated policy credit must be granted by the parent that set it.',
      );
    }
    return this.recordGrant(policy, {
      ...input,
      grantedByTenantId: input.grantedByTenantId || setBy,
    });
  }

  private async recordGrant(
    policy: SpendingPolicy,
    input: GrantCreditInput,
  ): Promise<CreditGrant> {
    if (policy.period !== 'balance') {
      throw new ResellerBillingError(
        `Spending policy '${policy.name}' is not a balance policy.`,
        'POLICY_NOT_BALANCE',
      );
    }
    if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
      throw new ResellerBillingError(
        `Credit amount must be a nonzero integer number of minor units — got ${input.amount}.`,
        'INVALID_AMOUNT',
      );
    }
    const { credits } = await this.getLedgers();
    const source = input.source ?? '';
    const sourceId = input.sourceId ?? '';
    const id =
      source && sourceId
        ? await deterministicUuid([
            'credit-grant',
            String(policy.tenantId),
            String(policy.id),
            source,
            sourceId,
          ])
        : undefined;
    if (id) {
      const existing = await credits.get(id);
      if (existing) return existing;
    }
    try {
      return await credits.create({
        ...(id ? { id } : {}),
        tenantId: policy.tenantId,
        spendingPolicyId: String(policy.id),
        amount: input.amount,
        currency: policy.currency,
        reason: input.reason ?? '',
        source,
        sourceId,
        grantedByTenantId: input.grantedByTenantId ?? '',
        _insertOnly: Boolean(id),
      });
    } catch (error) {
      const concurrent = id ? await credits.get(id) : undefined;
      if (concurrent) return concurrent;
      throw error;
    }
  }

  private async evaluatePolicy(
    policy: SpendingPolicy,
    input: SpendingEvaluationInput,
    at: Date,
  ): Promise<SpendingDecision> {
    const estimatedAmount =
      input.estimatedAmounts?.[policy.basis] ?? input.estimatedAmount;
    const [start, end] = policyWindow(policy, at);
    const spent = await this.spentFor(policy, input.tenantId, start, end);
    if (policy.period !== 'balance') {
      return decide(policy, spent + estimatedAmount, policy.limitAmount);
    }
    let credit = await this.creditFor(policy);
    const projectedAmount = spent + estimatedAmount;
    const policyId = policy.id;
    if (projectedAmount > credit && this.extensions.autoTopUp && policyId) {
      const grant = await this.extensions.autoTopUp({
        policyId,
        tenantId: String(policy.tenantId),
        setByTenantId: tenantKey(policy.setByTenantId),
        currency: policy.currency,
        balanceAmount: credit - spent,
        estimatedAmount,
        shortfall: projectedAmount - credit,
      });
      if (grant) {
        // The hook is host code configured on this evaluator; its grant is
        // recorded with the policy's own grantor even when evaluation runs in
        // the constrained child's tenant context.
        await withSystemContext(() =>
          this.recordGrant(policy, {
            spendingPolicyId: policyId,
            amount: grant.amount,
            reason: grant.reason ?? 'auto top-up',
            source: grant.source ?? 'auto_top_up',
            sourceId: grant.sourceId,
            grantedByTenantId: tenantKey(policy.setByTenantId),
          }),
        );
        credit = await this.creditFor(policy);
      }
    }
    return {
      ...decide(policy, projectedAmount, credit),
      balanceAmount: credit - spent,
    };
  }

  /** Approved spend in the policy's window, currency, scope, and basis. */
  private async spentFor(
    policy: SpendingPolicy,
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const scope: Record<string, unknown> = {
      currency: policy.currency,
      'approvedAt >=': start.toISOString(),
      'approvedAt <': end.toISOString(),
    };
    if (policy.metricKey) scope.metricKey = policy.metricKey;
    if (policy.projectId) scope.projectId = policy.projectId;
    if (policy.serviceKey) scope.serviceKey = policy.serviceKey;
    if (policy.subscriberKind) scope.subscriberKind = policy.subscriberKind;
    if (policy.subscriberExternalId)
      scope.subscriberExternalId = policy.subscriberExternalId;

    const setBy = tenantKey(policy.setByTenantId);
    if (policy.basis === 'retail') {
      const { retailCharges } = await this.getLedgers();
      const where: Record<string, unknown> = {
        ...scope,
        tenantId,
        status: 'approved',
      };
      // A parent's cap counts only what the child owes that parent.
      if (setBy) where.resellerTenantId = setBy;
      const rows = await retailCharges.list({ where });
      return sumScoped(
        policy,
        rows.filter(
          (row) => !setBy || tenantKey(row.resellerTenantId) === setBy,
        ),
        ['approved'],
      );
    }

    if (policy.basis === 'wholesale') {
      if (!setBy) return 0;
      // Reviewed cross-tenant read: the parent's provider charges for this
      // child's usage, bounded to (payer = setBy, usageTenantId = tenant) and
      // reduced to a sum, so a child-context evaluation can enforce its
      // parent's wholesale cap without reading the parent's other rows.
      return withSystemContext(() =>
        this.sumProviderCharges(policy, scope, setBy, tenantId),
      );
    }
    return this.sumProviderCharges(policy, scope, tenantId);
  }

  private async sumProviderCharges(
    policy: SpendingPolicy,
    scope: Record<string, unknown>,
    payer: string,
    usageTenantId?: string,
  ): Promise<number> {
    const where: Record<string, unknown> = {
      ...scope,
      tenantId: payer,
      status: ['approved', 'adjusted'],
    };
    if (usageTenantId) where.usageTenantId = usageTenantId;
    const rows = await this.charges.list({ where });
    const scopedCharges = rows.filter(
      (charge) =>
        (!usageTenantId ||
          tenantKey(charge.usageTenantId) === tenantKey(usageTenantId)) &&
        (charge.status === 'approved' || charge.status === 'adjusted') &&
        matchesChargeScope(policy, charge),
    );
    const chargeIds = scopedCharges
      .map((charge) => charge.id)
      .filter((id): id is string => Boolean(id));
    const chargeIdSet = new Set(chargeIds);
    const adjustmentRows =
      chargeIds.length > 0
        ? await this.adjustments.list({
            where: {
              tenantId: payer,
              currency: policy.currency,
              clientChargeId: chargeIds,
            },
          })
        : [];
    const spent = scopedCharges.reduce((sum, charge) => sum + charge.amount, 0);
    return (
      spent +
      adjustmentRows
        .filter((adjustment) => chargeIdSet.has(adjustment.clientChargeId))
        .reduce((sum, adjustment) => sum + adjustment.amount, 0)
    );
  }

  private async creditFor(policy: SpendingPolicy): Promise<number> {
    const { credits } = await this.getLedgers();
    const grants = await credits.list({
      where: {
        tenantId: policy.tenantId,
        spendingPolicyId: policy.id,
        currency: policy.currency,
      },
    });
    // A delegated balance holds only credit its current parent granted: when
    // a new parent takes over the policy, a former parent's grants stay with
    // that former relationship instead of funding the new one.
    const setBy = tenantKey(policy.setByTenantId);
    return grants
      .filter(
        (grant) =>
          grant.spendingPolicyId === policy.id &&
          (!setBy || tenantKey(grant.grantedByTenantId) === setBy),
      )
      .reduce((sum, grant) => sum + grant.amount, 0);
  }

  private getLedgers(): Promise<{
    retailCharges: RetailChargeCollection;
    credits: CreditGrantCollection;
  }> {
    this.ledgers ??= (async () => {
      const options = { db: this.policies.db };
      return {
        retailCharges:
          this.extensions.retailCharges ??
          (await RetailChargeCollection.create(options)),
        credits:
          this.extensions.credits ??
          (await CreditGrantCollection.create(options)),
      };
    })();
    this.ledgers.catch(() => {
      this.ledgers = undefined;
    });
    return this.ledgers;
  }
}

function decide(
  policy: SpendingPolicy,
  projectedAmount: number,
  limitAmount: number,
): SpendingDecision {
  const exceeded = projectedAmount > limitAmount;
  const matchedPolicyId = policy.id ?? null;
  if (!exceeded || policy.behavior === 'observe')
    return {
      allowed: true,
      approvalRequired: false,
      state: exceeded ? 'observed' : 'ok',
      projectedAmount,
      matchedPolicyId,
    };
  if (policy.behavior === 'warn')
    return {
      allowed: true,
      approvalRequired: false,
      state: 'warned',
      projectedAmount,
      matchedPolicyId,
    };
  if (policy.behavior === 'approval_required')
    return {
      allowed: false,
      approvalRequired: true,
      state: 'approval_required',
      projectedAmount,
      matchedPolicyId,
    };
  return {
    allowed: false,
    approvalRequired: false,
    state: 'blocked',
    projectedAmount,
    matchedPolicyId,
  };
}

function sumScoped(
  policy: SpendingPolicy,
  rows: LedgerRow[],
  statuses: string[],
): number {
  return rows
    .filter(
      (row) => statuses.includes(row.status) && matchesChargeScope(policy, row),
    )
    .reduce((sum, row) => sum + row.amount, 0);
}

/**
 * The provider leg must be priced by someone other than the payer: a reseller
 * (or its child) never publishes the wholesale book it is charged from.
 */
export function assertWholesalePublisher(
  book: PriceBook,
  resellerTenantId: string,
  childTenantId: string,
): void {
  const publisher = tenantKey(book.tenantId);
  if (publisher === resellerTenantId || publisher === childTenantId) {
    throw new ResellerBillingError(
      `Wholesale price book '${book.bookKey}' is published by the tenant it would charge.`,
      'PRICE_BOOK_OWNER_MISMATCH',
    );
  }
}

async function loadBook(
  books: PriceBookCollection,
  id: string,
  kind: PriceBookKind,
): Promise<PriceBook> {
  const book = await books.get(id);
  if (!book?.id) {
    throw new ResellerBillingError(
      `Price book ${id} was not found.`,
      'PRICE_BOOK_NOT_FOUND',
    );
  }
  if (book.kind !== kind) {
    throw new ResellerBillingError(
      `Price book '${book.bookKey}' is a ${book.kind} book, not ${kind}.`,
      'PRICE_BOOK_KIND_MISMATCH',
    );
  }
  if (!book.active) {
    throw new ResellerBillingError(
      `Price book '${book.bookKey}' is inactive.`,
      'PRICE_BOOK_INACTIVE',
    );
  }
  return book;
}

function selectRule(
  rules: PricingRule[],
  at: Date,
  serviceKey: string,
): PricingRule | undefined {
  return rules
    .filter(
      (rule) =>
        rule.effectiveFrom <= at &&
        (!rule.effectiveTo || rule.effectiveTo > at) &&
        (!rule.serviceKey || rule.serviceKey === serviceKey),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.serviceKey)) - Number(Boolean(a.serviceKey)) ||
        b.priority - a.priority ||
        b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
    )[0];
}
function priceTiers(quantity: number, tiers: unknown[]): number {
  let remaining = quantity,
    prior = 0,
    amount = 0;
  for (const raw of tiers as Array<Record<string, unknown>>) {
    const upTo = raw.upTo == null ? Infinity : Number(raw.upTo);
    const units = Math.max(0, Math.min(remaining, upTo - prior));
    amount += units * Number(raw.unitPrice ?? 0);
    remaining -= units;
    prior = upTo;
    if (remaining <= 0) break;
  }
  return amount;
}
function selectPolicies(
  policies: SpendingPolicy[],
  input: Record<string, unknown>,
): SpendingPolicy[] {
  return policies
    .filter(
      (p) =>
        hasValidSubscriberScope(p) &&
        (!p.metricKey || p.metricKey === input.metricKey) &&
        p.currency === input.currency &&
        (!p.projectId || p.projectId === input.projectId) &&
        (!p.serviceKey || p.serviceKey === input.serviceKey) &&
        (!p.subscriberKind ||
          (p.subscriberKind === (input.subscriberKind ?? 'tenant') &&
            (!p.subscriberExternalId ||
              p.subscriberExternalId === input.subscriberExternalId))),
    )
    .sort((a, b) => scopeScore(b) - scopeScore(a) || b.priority - a.priority);
}

function decisionRank(decision: SpendingDecision): number {
  return {
    ok: 0,
    observed: 1,
    warned: 2,
    approval_required: 3,
    blocked: 4,
  }[decision.state];
}
function scopeScore(p: SpendingPolicy): number {
  return (
    Number(Boolean(p.subscriberKind)) +
    Number(Boolean(p.subscriberExternalId)) +
    Number(Boolean(p.projectId)) +
    Number(Boolean(p.serviceKey)) +
    Number(Boolean(p.metricKey))
  );
}
function matchesChargeScope(p: SpendingPolicy, c: LedgerRow): boolean {
  return (
    hasValidSubscriberScope(p) &&
    (!p.projectId || p.projectId === c.projectId) &&
    (!p.serviceKey || p.serviceKey === c.serviceKey) &&
    (!p.metricKey || p.metricKey === c.metricKey) &&
    (!p.subscriberKind ||
      (p.subscriberKind === c.subscriberKind &&
        (!p.subscriberExternalId ||
          p.subscriberExternalId === c.subscriberExternalId)))
  );
}
function hasValidSubscriberScope(p: SpendingPolicy): boolean {
  return !p.subscriberExternalId || Boolean(p.subscriberKind);
}
function policyWindow(policy: SpendingPolicy, at: Date): [Date, Date] {
  const end = new Date(at);
  const start = new Date(at);
  if (policy.period === 'balance')
    start.setTime(
      new Date(policy.balanceFrom ?? policy.created_at ?? 0).getTime(),
    );
  else if (policy.period === 'rolling')
    start.setTime(at.getTime() - policy.rollingSeconds * 1000);
  else if (policy.period === 'day') start.setUTCHours(0, 0, 0, 0);
  else if (policy.period === 'week') {
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  } else if (policy.period === 'month') {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
  } else {
    start.setUTCMonth(0, 1);
    start.setUTCHours(0, 0, 0, 0);
  }
  return [start, end];
}

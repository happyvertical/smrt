/** Campaign identity, budget, schedule, and guarded lifecycle. */

import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
  ValidationError,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
  TenantScoped,
  tenantId,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  assertCustomersBelongToTenant,
  normalizeUuid,
} from '../customer-scope.js';
import { CampaignCustomerScopeError } from '../errors.js';
import {
  CAMPAIGN_STATUSES,
  type CampaignOptions,
  type CampaignStatus,
} from '../types.js';

const CAMPAIGN_STATUS_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['scheduled'],
  scheduled: ['active'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: ['archived'],
  archived: [],
};

const loadedCampaignStatus = new WeakMap<Campaign, CampaignStatus>();

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'campaigns',
  conflictColumns: ['tenant_id', 'campaign_key'],
  indexes: [
    {
      name: 'campaigns_tenant_id_customer_id_start_at_id_idx',
      columns: ['tenantId', 'customerId', 'startAt', 'id'],
    },
  ],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: { include: ['list', 'get', 'create', 'update'] },
})
export class Campaign extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Canonical commerce Customer that owns this campaign, when assigned. */
  @crossPackageRef('@happyvertical/smrt-commerce:Customer', {
    nullable: true,
    validate: true,
  })
  customerId: string | null = null;

  /** Stable caller-defined key used by CRM/referral systems. */
  @field({ required: true })
  campaignKey: string = '';

  @field({ required: true })
  name: string = '';

  /** Open objective key such as `awareness` or `demand_generation`. */
  objective: string = '';

  status: CampaignStatus = 'draft';

  startAt: Date | null = null;

  endAt: Date | null = null;

  /** Total campaign budget in integer cents. */
  budgetCents: number = 0;

  /** ISO 4217 currency for every campaign/channel amount. */
  currency: string = 'USD';

  metadata: string = '{}';

  constructor(options: CampaignOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.customerId !== undefined) this.customerId = options.customerId;
    if (options.campaignKey !== undefined)
      this.campaignKey = options.campaignKey;
    if (options.name !== undefined) this.name = options.name;
    if (options.objective !== undefined) this.objective = options.objective;
    if (options.status !== undefined) this.status = options.status;
    if (options.startAt !== undefined)
      this.startAt = Campaign.coerceDate(options.startAt);
    if (options.endAt !== undefined)
      this.endAt = Campaign.coerceDate(options.endAt);
    if (options.budgetCents !== undefined)
      this.budgetCents = options.budgetCents;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  override async initialize(): Promise<this> {
    if (this.id) {
      try {
        this.id = normalizeUuid(this.id, 'id');
      } catch (error) {
        if (this.customerId !== null) {
          throw new CampaignCustomerScopeError('Campaign.initialize');
        }
        throw error;
      }
    }
    await super.initialize();
    this.startAt = Campaign.coerceDate(this.startAt);
    this.endAt = Campaign.coerceDate(this.endAt);
    loadedCampaignStatus.set(this, this.status);
    return this;
  }

  override async save(): Promise<this> {
    if (this.customerId === null) return this.saveLifecycle();

    const db = this.db;
    if (typeof db.transaction !== 'function') {
      throw new Error(
        'Campaign.save requires a database adapter with transaction support.',
      );
    }
    return db.transaction(async (transactionDb) =>
      this.withDatabase(transactionDb, async (bound) => bound.saveLifecycle()),
    );
  }

  private async saveLifecycle(): Promise<this> {
    this.prepareIdentityForSave();
    if (this.customerId !== null) {
      await assertCustomersBelongToTenant(
        this.options,
        this.tenantId,
        [this.customerId],
        'Campaign.save',
        'update',
      );
    }
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    this.assertSchedule();
    let result: this;
    try {
      const persist = async () => (await super.save()) as this;
      const tenantContext =
        isSystemContext() || isSuperAdminBypass()
          ? undefined
          : getCurrentTenant();
      result = tenantContext
        ? await withTenant(
            {
              ...tenantContext,
              tenantId: this.tenantId ?? tenantContext.tenantId,
            },
            persist,
          )
        : await persist();
    } catch (error) {
      if (
        error instanceof ValidationError &&
        (error.code === 'VALIDATION_CROSS_PACKAGE_REF_MISSING' ||
          error.code === 'VALIDATION_CROSS_PACKAGE_REF_UNREGISTERED')
      ) {
        throw new CampaignCustomerScopeError('Campaign.save');
      }
      throw error;
    }
    loadedCampaignStatus.set(this, this.status);
    return result;
  }

  /** Canonicalize and authorize identity before any status or scope read. */
  private prepareIdentityForSave(): void {
    try {
      if (this.id) this.id = normalizeUuid(this.id, 'id');
      if (this.customerId !== null) {
        this.customerId = normalizeUuid(this.customerId, 'customerId');
      }
      if (this.tenantId !== null) {
        this.tenantId = normalizeUuid(this.tenantId, 'tenantId');
      }
    } catch (error) {
      if (this.customerId !== null) {
        throw new CampaignCustomerScopeError('Campaign.save');
      }
      throw error;
    }

    if (isSystemContext() || isSuperAdminBypass()) return;
    const tenantContext = getCurrentTenant();
    if (!tenantContext) return;

    let contextTenantId: string;
    try {
      contextTenantId = normalizeUuid(tenantContext.tenantId, 'tenantId');
    } catch (error) {
      if (this.customerId !== null) {
        throw new CampaignCustomerScopeError('Campaign.save');
      }
      throw error;
    }
    if (this.tenantId !== null && this.tenantId !== contextTenantId) {
      throw new TenantIsolationError(
        'Tenant isolation violation in Campaign.save.',
        { tenantId: contextTenantId, attemptedTenantId: this.tenantId },
      );
    }
    this.tenantId = contextTenantId;
  }

  /** Apply one legal transition in memory; callers choose the save boundary. */
  transitionTo(next: CampaignStatus): this {
    if (next === this.status) return this;
    const allowed = CAMPAIGN_STATUS_TRANSITIONS[this.status] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(
        `Campaign ${this.campaignKey || this.id}: cannot transition ` +
          `'${this.status}' → '${next}'.`,
      );
    }
    this.status = next;
    return this;
  }

  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      const parsed = JSON.parse(this.metadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata ?? {});
  }

  private assertSchedule(): void {
    if (
      this.startAt &&
      this.endAt &&
      this.endAt.getTime() < this.startAt.getTime()
    ) {
      throw new Error('Campaign endAt must be on or after startAt.');
    }
    if (!Number.isInteger(this.budgetCents) || this.budgetCents < 0) {
      throw new Error('Campaign budgetCents must be a non-negative integer.');
    }
  }

  private async resolvePriorStatus(): Promise<CampaignStatus | undefined> {
    if (this.id) {
      let scopedRow: Record<string, unknown> | null = null;
      try {
        scopedRow = await this.db.get(this.tableName, {
          id: this.id,
          tenant_id: this.tenantId,
        });
      } catch {
        // DB not ready / table absent; fall through to the hydrated state.
      }
      if (scopedRow?.status != null) {
        return scopedRow.status as CampaignStatus;
      }

      // A caller-supplied ID already owned by another lane must not expose its
      // lifecycle state or be repurposed by an upsert.
      let rowInAnotherLane: Record<string, unknown> | null = null;
      try {
        rowInAnotherLane = await this.db.get(this.tableName, { id: this.id });
      } catch {
        // DB not ready / table absent; fall through to the hydrated state.
      }
      if (rowInAnotherLane) {
        throw new CampaignCustomerScopeError('Campaign.save');
      }
    }
    if (this.campaignKey) {
      try {
        const row = await this.db.get(this.tableName, {
          tenant_id: this.tenantId,
          campaign_key: this.campaignKey,
        });
        if (row && row.status != null) return row.status as CampaignStatus;
      } catch {
        // DB not ready / table absent; fall through to the hydrated state.
      }
    }
    return loadedCampaignStatus.get(this);
  }

  private assertStatusTransition(prior: CampaignStatus | undefined): void {
    if (!CAMPAIGN_STATUSES.includes(this.status)) {
      throw new Error(
        `Campaign ${this.campaignKey || this.id}: unknown status '${this.status}'.`,
      );
    }
    if (prior === undefined || prior === this.status) return;
    const allowed = CAMPAIGN_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Campaign ${this.campaignKey || this.id}: illegal status transition ` +
          `'${prior}' → '${this.status}'.`,
      );
    }
  }

  private static coerceDate(value: unknown): Date | null {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number' || typeof value === 'string') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }
}

export default Campaign;

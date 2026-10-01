import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

const chargeSnapshot = new WeakMap<ServiceChargeSnapshot, string>();
const compensationSnapshot = new WeakMap<ServiceCompensationSnapshot, string>();

async function immutableCommercialSnapshot(
  object: SmrtObject,
  fields: string[],
): Promise<string | null> {
  if (!object.id) return null;
  try {
    const row = await object.db.get(object.tableName, { id: object.id });
    if (!row) return null;
    return JSON.stringify(
      Object.fromEntries(
        fields.map((key) => [
          key,
          row[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] ?? null,
        ]),
      ),
    );
  } catch {
    return null;
  }
}

function commercialSnapshot(
  object: Record<string, unknown>,
  fields: string[],
): string {
  return JSON.stringify(
    Object.fromEntries(fields.map((key) => [key, object[key] ?? null])),
  );
}

const CHARGE_FIELDS = [
  'timeEntryId',
  'amount',
  'currency',
  'pricingVersion',
  'strategy',
  'rateSnapshot',
  'sourceChargeRef',
];
const COMPENSATION_FIELDS = [
  'timeEntryId',
  'amount',
  'currency',
  'termsVersion',
  'rateSnapshot',
];

/**
 * Immutable client-charge snapshot for one approved time entry. Money is
 * integer minor units, consistent with smrt-commerce (#2401).
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'service_charge_snapshots',
  conflictColumns: ['time_entry_id'],
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class ServiceChargeSnapshot extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('ServiceTimeEntry', { required: true }) timeEntryId: string = '';
  /**
   * Client charge in **integer minor units** of {@link currency} — `$19.99` is
   * `1999`. The `= 0` initializer is load-bearing: SMRT maps an integer literal
   * to INTEGER and a decimal literal to DECIMAL (#2401).
   *
   * Copied verbatim from the upstream `ClientCharge.amount`, so the two carry
   * the same unit by construction; a split would land cents in a major-units
   * column with no error anywhere.
   */
  amount: number = 0;
  @field({ type: 'text' }) currency: string = 'USD';
  @field({ type: 'text' }) pricingVersion: string = '';
  @field({ type: 'text' }) strategy: string = '';
  @field({ type: 'text' }) rateSnapshot: string = '{}';
  @field({ type: 'text' }) sourceChargeRef: string = '';
  createdAt: Date = new Date();

  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved())
      chargeSnapshot.set(
        this,
        commercialSnapshot(
          this as unknown as Record<string, unknown>,
          CHARGE_FIELDS,
        ),
      );
    return this;
  }

  override async save(): Promise<this> {
    const current = commercialSnapshot(
      this as unknown as Record<string, unknown>,
      CHARGE_FIELDS,
    );
    const prior =
      (await immutableCommercialSnapshot(this, CHARGE_FIELDS)) ??
      chargeSnapshot.get(this) ??
      null;
    if (prior && prior !== current)
      throw new Error(
        'ServiceChargeSnapshot is immutable; append an upstream adjustment instead.',
      );
    const result = (await super.save()) as this;
    chargeSnapshot.set(this, current);
    return result;
  }
}

/**
 * Immutable provider-compensation snapshot for one approved time entry,
 * kept separate from the client charge so the margin is `charge - compensation`.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'service_compensation_snapshots',
  conflictColumns: ['time_entry_id'],
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class ServiceCompensationSnapshot extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('ServiceTimeEntry', { required: true }) timeEntryId: string = '';
  /**
   * Provider earning in **integer minor units** of {@link currency} (#2401).
   *
   * Converts with {@link ServiceChargeSnapshot.amount}: the delivery margin is
   * `charge - compensation`, so a mixed pair would make that subtraction
   * meaningless.
   */
  amount: number = 0;
  @field({ type: 'text' }) currency: string = 'USD';
  @field({ type: 'text' }) termsVersion: string = '';
  @field({ type: 'text' }) rateSnapshot: string = '{}';
  createdAt: Date = new Date();

  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved())
      compensationSnapshot.set(
        this,
        commercialSnapshot(
          this as unknown as Record<string, unknown>,
          COMPENSATION_FIELDS,
        ),
      );
    return this;
  }

  override async save(): Promise<this> {
    const current = commercialSnapshot(
      this as unknown as Record<string, unknown>,
      COMPENSATION_FIELDS,
    );
    const prior =
      (await immutableCommercialSnapshot(this, COMPENSATION_FIELDS)) ??
      compensationSnapshot.get(this) ??
      null;
    if (prior && prior !== current)
      throw new Error(
        'ServiceCompensationSnapshot is immutable; create explicit settlement evidence instead.',
      );
    const result = (await super.save()) as this;
    compensationSnapshot.set(this, current);
    return result;
  }
}

/** Collection over `service_charge_snapshots`. */
export class ServiceChargeSnapshotCollection extends SmrtCollection<ServiceChargeSnapshot> {
  static readonly _itemClass = ServiceChargeSnapshot;
}
/** Collection over `service_compensation_snapshots`. */
export class ServiceCompensationSnapshotCollection extends SmrtCollection<ServiceCompensationSnapshot> {
  static readonly _itemClass = ServiceCompensationSnapshot;
}

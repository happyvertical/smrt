import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
  tenantId,
} from '@happyvertical/smrt-tenancy';

/**
 * Cap on distinct-user ids stored per bucket. For threshold questions
 * ("did at least N distinct users set this field?") the capped set is EXACT up
 * to the cap; once overflowed, {@link FieldUsageCounter.distinctUserCount} is
 * an honest LOWER BOUND that trivially satisfies any threshold ≤ the cap.
 */
export const MAX_DISTINCT_USERS_PER_BUCKET = 100;

/** Cap on histogram buckets per counter row (bounded storage). */
export const MAX_VALUE_HISTOGRAM_BUCKETS = 25;

/** Longest histogram key recorded; longer samples are skipped (count-only). */
export const MAX_VALUE_HISTOGRAM_KEY_LENGTH = 64;

/** `period` bucket format: UTC calendar day. */
export const FIELD_USAGE_PERIOD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC day bucket for a timestamp (`YYYY-MM-DD`). */
export function fieldUsagePeriodForDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A prototype-free histogram map.
 *
 * Histogram keys are user-supplied values (an `idType: 'text'` reference id may
 * legitimately be `constructor`, `toString`, or `__proto__`). On a plain object
 * those either resolve to inherited members — making an absent bucket look
 * present and corrupting its count — or, for `__proto__`, invoke the prototype
 * setter instead of creating an own key. A null-prototype object has no such
 * members, so every key behaves like data. Use this everywhere histogram counts
 * are accumulated (storage AND merge paths).
 */
export function emptyHistogram(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

export interface FieldUsageCounterOptions extends SmrtObjectOptions {
  objectRef?: string;
  fieldName?: string;
  tenantId?: string;
  period?: string;
  submissionCount?: number;
  setCount?: number;
  distinctUserCount?: number;
  distinctUserIds?: string;
  distinctUsersOverflowed?: boolean;
  valueHistogram?: string | null;
  valueHistogramOverflowed?: boolean;
}

/**
 * Period-bucketed field usage counter (epic #2045, issue #2051).
 *
 * One row aggregates field submissions for a single
 * `(objectRef, fieldName, tenantId, period)` — the substrate the
 * suggestion-generation job reads. Counters are deliberately APPROXIMATE:
 * ingestion is fire-and-forget and concurrent bucket merges may lose an
 * increment (read-modify-write), which is acceptable for usage statistics and
 * documented here rather than papered over.
 *
 * TWO counters, because they answer different questions:
 * - {@link submissionCount} — EVERY observed submission of the field
 *   (default-matching or not). It is the denominator for value dominance:
 *   "N% of submissions used value V". Without it, a value seen only in
 *   deviations would look 100% dominant even against thousands of
 *   default-valued submissions.
 * - {@link setCount} — submissions whose value DIFFERED from the resolved
 *   default (server-derived). It plus {@link distinctUserIds} is the
 *   promote signal ("real users are actively filling this in").
 *
 * Content rails (enforced by the ingestion action, which derives everything
 * from the live registry and never trusts the client):
 * - Sensitive and read-permission-gated fields are COUNT-ONLY: their raw
 *   values are never recorded anywhere in usage data — not even for
 *   default-matching submissions.
 * - Value histograms exist only for low-cardinality field types (`boolean`,
 *   `foreignKey`, `crossPackageRef`) — never free text, even non-sensitive
 *   text (PII risk) — with a bounded bucket count and key length. They cover
 *   ALL submissions (not just deviations) so the dominance ratio is a true
 *   fraction of {@link submissionCount}.
 * - `distinctUserIds` is a capped set with an overflow marker (see
 *   {@link MAX_DISTINCT_USERS_PER_BUCKET} for the honesty contract).
 */
// All generated surfaces are CLOSED: rows aggregate cross-tenant usage, so
// list/get would leak other tenants' activity and create/update/delete would
// let clients forge counters. The ONLY write path is the collection's
// `reportUsage` action (ambient-identity, fail closed); reads happen
// server-side in the learning jobs.
@smrt({
  tableName: '_smrt_field_usage_counters',
  conflictColumns: ['object_ref', 'field_name', 'tenant_id', 'period'],
  api: { include: [] },
  cli: false,
  mcp: { include: [] },
})
export class FieldUsageCounter extends SmrtObject {
  /** Qualified class name of the target object (`@package/name:ClassName`). */
  @field({ required: true })
  objectRef: string = '';

  /** Field name on the target object. */
  @field({ required: true })
  fieldName: string = '';

  /**
   * Owning tenant. REQUIRED: ingestion fails closed without an ambient tenant
   * context, so every row is attributable (and the conflict-column tuple
   * stays total). Native UUID on PostgreSQL/DuckDB.
   */
  @tenantId()
  tenantId?: string;

  /** UTC day bucket (`YYYY-MM-DD`); lexicographic order is time order. */
  @field({ required: true })
  period: string = '';

  /**
   * EVERY observed submission of this field in the bucket, whether or not the
   * value matched the resolved default — the dominance denominator.
   *
   * Rows written before this column existed carry `0` while `setCount > 0`;
   * {@link isLegacyBucket} detects that shape and the generation job then
   * treats the total as UNKNOWN and skips `default` suggestions for the group
   * (promote, which needs no denominator, still works).
   */
  @field({ type: 'integer' })
  submissionCount: number = 0;

  /**
   * Submissions whose value DIFFERED from the server-resolved default (the
   * promote signal). Always `<= submissionCount` on rows written by the
   * current ingestion path.
   */
  @field({ type: 'integer' })
  setCount: number = 0;

  /**
   * Size of the stored distinct-user set. When
   * {@link distinctUsersOverflowed} is true this is a LOWER BOUND (the set is
   * capped), never an estimate.
   */
  @field({ type: 'integer' })
  distinctUserCount: number = 0;

  /** JSON array of distinct user ids, capped (see the class doc). */
  @field({ type: 'text' })
  distinctUserIds: string = '[]';

  /** True once a distinct user was NOT added because the set is at its cap. */
  @field({ type: 'boolean' })
  distinctUsersOverflowed: boolean = false;

  /**
   * JSON object `serializedValue -> count` for histogram-eligible fields;
   * NULL when the field is count-only. Keys are bounded in number and length.
   */
  @field({ type: 'text', nullable: true })
  valueHistogram: string | null = null;

  /** True once a sample was dropped because the bucket cap was reached. */
  @field({ type: 'boolean' })
  valueHistogramOverflowed: boolean = false;

  constructor(options: FieldUsageCounterOptions = {}) {
    super(options);
    if (options.objectRef !== undefined) this.objectRef = options.objectRef;
    if (options.fieldName !== undefined) this.fieldName = options.fieldName;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.period !== undefined) this.period = options.period;
    if (options.submissionCount !== undefined) {
      this.submissionCount = options.submissionCount;
    }
    if (options.setCount !== undefined) this.setCount = options.setCount;
    if (options.distinctUserCount !== undefined) {
      this.distinctUserCount = options.distinctUserCount;
    }
    if (options.distinctUserIds !== undefined) {
      this.distinctUserIds = options.distinctUserIds;
    }
    if (options.distinctUsersOverflowed !== undefined) {
      this.distinctUsersOverflowed = options.distinctUsersOverflowed;
    }
    if (options.valueHistogram !== undefined) {
      this.valueHistogram = options.valueHistogram;
    }
    if (options.valueHistogramOverflowed !== undefined) {
      this.valueHistogramOverflowed = options.valueHistogramOverflowed;
    }
  }

  /** Parse the stored distinct-user set (guarded; junk parses as empty). */
  getDistinctUserIds(): string[] {
    try {
      const parsed = JSON.parse(this.distinctUserIds);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Add a user to the distinct set, honoring the cap. At the cap the id is
   * NOT added and the overflow marker is set instead, keeping
   * {@link distinctUserCount} an honest lower bound.
   */
  addDistinctUser(userId: string): void {
    const ids = this.getDistinctUserIds();
    if (ids.includes(userId)) {
      return;
    }
    if (ids.length >= MAX_DISTINCT_USERS_PER_BUCKET) {
      this.distinctUsersOverflowed = true;
      return;
    }
    ids.push(userId);
    this.distinctUserIds = JSON.stringify(ids);
    this.distinctUserCount = ids.length;
  }

  /**
   * Parse the stored histogram (guarded; junk parses as empty).
   *
   * Returns a NULL-PROTOTYPE object. Histogram keys are user-supplied ids —
   * an `idType: 'text'` reference may legitimately be `constructor`,
   * `toString`, or `__proto__` — and on a plain object those inherit truthy
   * prototype values (so a missing bucket reads as present) or, for
   * `__proto__`, hit the prototype setter instead of creating an own key.
   * Both would silently corrupt counts. See {@link emptyHistogram}.
   */
  getValueHistogram(): Record<string, number> {
    const histogram = emptyHistogram();
    if (!this.valueHistogram) {
      return histogram;
    }
    try {
      const parsed = JSON.parse(this.valueHistogram);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return histogram;
      }
      // `Object.entries` yields OWN enumerable keys only, and `JSON.parse`
      // materializes `__proto__` as an ordinary own data property, so the
      // round trip preserves every legitimate id.
      for (const [key, count] of Object.entries(parsed)) {
        if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
          histogram[key] = count;
        }
      }
      return histogram;
    } catch {
      return emptyHistogram();
    }
  }

  /**
   * Record one histogram sample under an already-serialized key, honoring the
   * bucket cap (a NEW key past the cap is dropped and the overflow marker
   * set; existing keys keep counting).
   *
   * Bucket presence is an OWN-key test, never a truthiness/`undefined` read,
   * so prototype-shaped ids behave like any other key.
   */
  recordHistogramSample(key: string): void {
    if (key.length === 0 || key.length > MAX_VALUE_HISTOGRAM_KEY_LENGTH) {
      return;
    }
    const histogram = this.getValueHistogram();
    if (!Object.hasOwn(histogram, key)) {
      if (Object.keys(histogram).length >= MAX_VALUE_HISTOGRAM_BUCKETS) {
        this.valueHistogramOverflowed = true;
        return;
      }
      histogram[key] = 1;
    } else {
      histogram[key] += 1;
    }
    this.valueHistogram = JSON.stringify(histogram);
  }

  /**
   * Whether this bucket predates the {@link submissionCount} column (or was
   * corrupted): it records deviations without a total, so no honest dominance
   * ratio can be computed from it. The generation job skips `default`
   * suggestions for any group containing such a bucket.
   */
  isLegacyBucket(): boolean {
    return this.submissionCount < this.setCount;
  }

  override async save(): Promise<this> {
    await this.assertRowOwnedByAmbientContext('save');
    this.validateFieldUsageCounter();
    return super.save();
  }

  override async delete(): Promise<void> {
    await this.assertRowOwnedByAmbientContext('delete');
    await super.delete();
  }

  private validateFieldUsageCounter(): void {
    if (!this.objectRef || this.objectRef.trim() === '') {
      throw new Error('FieldUsageCounter.objectRef is required');
    }
    if (!this.fieldName || this.fieldName.trim() === '') {
      throw new Error('FieldUsageCounter.fieldName is required');
    }
    if (!this.tenantId) {
      throw new Error('FieldUsageCounter.tenantId is required');
    }
    if (!FIELD_USAGE_PERIOD_PATTERN.test(this.period)) {
      throw new Error(
        `FieldUsageCounter.period must be a UTC day bucket (YYYY-MM-DD); ` +
          `got "${this.period}"`,
      );
    }
    if (!Number.isInteger(this.submissionCount) || this.submissionCount < 0) {
      throw new Error(
        'FieldUsageCounter.submissionCount must be a non-negative integer',
      );
    }
    if (!Number.isInteger(this.setCount) || this.setCount < 0) {
      throw new Error(
        'FieldUsageCounter.setCount must be a non-negative integer',
      );
    }
    if (
      !Number.isInteger(this.distinctUserCount) ||
      this.distinctUserCount < 0
    ) {
      throw new Error(
        'FieldUsageCounter.distinctUserCount must be a non-negative integer',
      );
    }
  }

  /**
   * Tenant write boundary (the FieldPolicy posture — no class-level
   * `@TenantScoped`, because the learning jobs legitimately operate
   * cross-tenant in trusted execution): inside a non-bypass tenant context a
   * caller may only touch rows of its own tenant; without a context (system/
   * job execution) writes are trusted.
   *
   * Checked against BOTH the in-memory tenant and — for a row that already
   * exists — the PERSISTED one. The persisted check is what makes the boundary
   * real: bucket ids are deterministic and the deriving helper is exported, so
   * a foreign row is trivially addressable, and an in-memory-only check would
   * let a caller load it, re-stamp `tenantId` with its own, and adopt or delete
   * another tenant's counters (the #2047 FieldPolicy pattern).
   */
  private async assertRowOwnedByAmbientContext(
    operation: 'save' | 'delete',
  ): Promise<void> {
    const context = getCurrentTenant();
    if (!context || isSuperAdminBypass()) {
      return;
    }
    if (this.tenantId !== context.tenantId) {
      throw new TenantIsolationError(
        `Tenant isolation violation in FieldUsageCounter.${operation}: ` +
          `context tenant is '${context.tenantId}' but the row belongs to ` +
          `'${this.tenantId}'`,
        {
          tenantId: context.tenantId,
          attemptedTenantId: this.tenantId ?? undefined,
        },
      );
    }

    const persistedTenantId = await this.getPersistedTenantId();
    if (persistedTenantId !== null && persistedTenantId !== context.tenantId) {
      throw new TenantIsolationError(
        `Tenant isolation violation in FieldUsageCounter.${operation}: the ` +
          `persisted row belongs to '${persistedTenantId}'`,
        {
          tenantId: context.tenantId,
          attemptedTenantId: persistedTenantId,
        },
      );
    }
  }

  /** The stored tenant for this row's id; `null` when it is not persisted. */
  private async getPersistedTenantId(): Promise<string | null> {
    if (!this.id) {
      return null;
    }
    const existing = await this.db.get(this.tableName, { id: this.id });
    if (!existing) {
      return null;
    }
    const row = existing as Record<string, unknown>;
    const value = row.tenantId ?? row.tenant_id;
    return value === undefined || value === null ? null : String(value);
  }
}

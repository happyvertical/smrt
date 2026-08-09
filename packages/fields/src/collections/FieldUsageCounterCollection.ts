import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import { deterministicFieldsUuid } from '../deterministic-id.js';
import {
  type FieldDefinitionMap,
  getFieldReadPermission,
  getObjectFieldMap,
  isSensitiveField,
  isStorableReferenceId,
  isTransientField,
  type RegisteredFieldInfo,
} from '../field-definitions.js';
import {
  FieldUsageCounter,
  fieldUsagePeriodForDate,
  MAX_VALUE_HISTOGRAM_KEY_LENGTH,
} from '../models/FieldUsageCounter.js';
import { FieldUsageReportReceipt } from '../models/FieldUsageReportReceipt.js';
import type {
  FieldUsageReportEntry,
  FieldUsageReportResult,
  ResolvedFieldPolicy,
} from '../types.js';

/**
 * Deviation comparison: strict equality, then a JSON round-trip so structured
 * and Date-shaped values compare by serialization. Mirrors the browser-side
 * `usageValuesEqual` (the packaging boundary bars value imports across the
 * subpath split — the permission-slug precedent); a node test pins the two
 * behaviours equal.
 */
export function usageValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Per-call bound on reported entries — the rate rail for the fire-and-forget
 * ingestion action (the resolveBatch precedent). Mirrored browser-side by
 * `src/svelte/usage-capture.ts` (`USAGE_REPORT_BATCH_LIMIT`); a node test
 * pins the two equal.
 */
export const MAX_USAGE_REPORT_ENTRIES = 100;

/** Expected generated-route denial for a missing trusted report principal. */
class FieldUsageRequestContextError extends TenantIsolationError {
  readonly httpStatus = 403;
  readonly status = 403;

  constructor(message: string, details?: { tenantId?: string }) {
    super(message, details);
    this.name = 'FieldUsageRequestContextError';
  }
}

/**
 * Collection surface for {@link FieldUsageCounter} plus the batched usage
 * ingestion action (#2051).
 *
 * `reportUsage` is a custom collection-scoped action (the resolveBatch
 * mechanism — single-segment path, so the generated SvelteKit transport AND
 * core's runtime `APIGenerator` both dispatch it). Everything else is CLOSED:
 * no generated CRUD, no CLI, no MCP — counters are written only through this
 * action and read only by trusted server-side code (the learning jobs).
 */
@smrt({
  // A decorated collection emits its own schema for the item's table. Mirror
  // the model natural key so manifest-driven migrations cannot add the
  // fallback `(slug, context)` unique index to this shared system table.
  conflictColumns: ['object_ref', 'field_name', 'tenant_id', 'period'],
  api: {
    include: ['reportUsage'],
    // The action derives tenant/user exclusively from the authenticated
    // request context; generated routes must establish that context before
    // dispatching it (the FieldPolicyCollection precedent).
    principalContext: true,
    routes: {
      reportUsage: {
        scope: 'collection',
        method: 'POST',
        path: 'report',
      },
    },
  },
  cli: false,
  mcp: false,
})
export class FieldUsageCounterCollection extends SmrtCollection<FieldUsageCounter> {
  static readonly _itemClass = FieldUsageCounter;

  /**
   * Record a batch of field submissions into the current UTC-day counters.
   *
   * Identity is AMBIENT-ONLY (the resolveBatch posture): the tenant AND the
   * user come exclusively from the tenant context established by the app's
   * auth hook — the request body cannot attribute usage to another tenant or
   * user. Both are REQUIRED and the call fails closed without them (#2047
   * round-3 posture):
   *
   * - No ambient tenant ⇒ the report is unattributable.
   * - No ambient USER ⇒ the caller is an unauthenticated principal (a
   *   deployment that resolves the tenant from host/header alone). Such
   *   callers could otherwise inflate counts and histograms without bound
   *   (the batch cap is per call), and `distinctUsers` — the promote signal —
   *   is meaningless without a principal. Consequence, accepted deliberately:
   *   ANONYMOUS/PUBLIC FORMS DO NOT CONTRIBUTE USAGE. The learning loop is
   *   for authenticated org users.
   *
   * Any authenticated in-tenant principal may report (no manage slug needed).
   * A durable receipt admits at most one `(tenant, user, object, field, UTC
   * day)` contribution, and the batch stays bounded per call
   * ({@link MAX_USAGE_REPORT_ENTRIES}).
   *
   * Server-side derivation (the client is never the authority):
   * - Fields are validated against the live `ObjectRegistry`; unknown or
   *   non-usage-addressable entries (system, relationship pseudo-fields, STI
   *   meta storage, transient) are DROPPED and counted, never failing the
   *   batch (stale clients after a redeploy are expected).
   * - Sensitivity comes from BOTH `field.sensitive` and `field._meta.sensitive`
   *   (and `readPermission` in both places): such fields are recorded
   *   COUNT-ONLY — their values are never persisted anywhere in usage data,
   *   default-matching or not.
   * - DEVIATION (`setCount`, distinct users) is decided by comparing the
   *   submitted value against the default RESOLVED HERE for the calling
   *   identity — never against a client claim. Every accepted entry also
   *   increments `submissionCount`, the dominance denominator.
   * - Values are histogrammed only for low-cardinality field types
   *   (`boolean`, `foreignKey`, `crossPackageRef`) with type-checked samples;
   *   free text is never histogrammed.
   *
   * Bounded trust in `matchedDefault`: an entry may omit `value` entirely
   * (`collectFieldUsageEntries({ includeValues: false })` — apps that prefer
   * no value transit). Only then is the entry's `matchedDefault` flag read, to
   * decide the deviation bit alone. It can never create a histogram entry,
   * never bypass the count-only rail, and never manufacture distinct users
   * beyond the caller's own id. The once-per-field/day receipt means a lying
   * client gets only one such contribution, so repeated POSTs cannot inflate
   * thresholds or steer a `default` suggestion.
   */
  async reportUsage(
    options: { entries?: FieldUsageReportEntry[] } = {},
  ): Promise<FieldUsageReportResult> {
    const entries = validateEntriesInput(options.entries);

    const context = getCurrentTenant();
    const tenantId = context?.tenantId;
    if (!tenantId) {
      throw new FieldUsageRequestContextError(
        'reportUsage requires an ambient tenant context: usage is ' +
          'unattributable without one, so the call fails closed',
      );
    }
    const userId = context.userId;
    if (!userId) {
      throw new FieldUsageRequestContextError(
        'reportUsage requires an ambient AUTHENTICATED user: an ' +
          'unauthenticated caller could inflate counters without bound and ' +
          'distinct-user thresholds are meaningless without a principal, so ' +
          'the call fails closed (anonymous forms do not contribute usage)',
        { tenantId },
      );
    }
    const period = fieldUsagePeriodForDate(new Date());
    const receipts = await FieldUsageReportReceiptCollection.create({
      db: this.db,
    });

    // Group by (objectRef, fieldName) so one bucket row is touched once per
    // batch (bounds registry and db work per call).
    const groups = new Map<string, Map<string, FieldUsageReportEntry[]>>();
    for (const entry of entries) {
      let byField = groups.get(entry.objectRef);
      if (!byField) {
        byField = new Map<string, FieldUsageReportEntry[]>();
        groups.set(entry.objectRef, byField);
      }
      const samples = byField.get(entry.fieldName);
      if (samples) {
        samples.push(entry);
      } else {
        byField.set(entry.fieldName, [entry]);
      }
    }

    let accepted = 0;
    let dropped = 0;

    for (const [objectRef, byField] of groups) {
      let fieldMap: FieldDefinitionMap;
      try {
        fieldMap = await getObjectFieldMap(objectRef);
      } catch {
        for (const samples of byField.values()) {
          dropped += samples.length;
        }
        continue;
      }

      const resolvedFields = await this.resolveDefaultsForCaller(
        objectRef,
        tenantId,
        userId,
      );
      if (!resolvedFields) {
        // Defaults are the deviation authority; without them every entry
        // would have to be guessed. Drop the group rather than guess.
        for (const samples of byField.values()) {
          dropped += samples.length;
        }
        continue;
      }

      for (const [fieldName, samples] of byField) {
        const fieldDef = fieldMap.get(fieldName);
        if (!fieldDef || !isUsageAddressableField(fieldDef)) {
          dropped += samples.length;
          continue;
        }

        // The durable receipt is the rate rail: at most ONE sample from this
        // user can influence this field's evidence per UTC day, even across
        // repeated requests or concurrent app replicas. Claim it only after
        // registry validation, so a stale/unknown field cannot burn a valid
        // field's daily allowance. Repeated reports are intentionally ignored
        // (not reported as `dropped`, which is reserved for stale entries).
        if (
          !(await receipts.claim({
            tenantId,
            userId,
            objectRef,
            fieldName,
            period,
          }))
        ) {
          continue;
        }

        // Batches can carry more than one value for a field, but the same
        // daily rule applies within one request too. The first sample is the
        // one durable contribution for this member/day/field.
        const sample = samples[0];

        const countOnly =
          isSensitiveField(fieldDef) ||
          getFieldReadPermission(fieldDef) !== undefined;
        const histogramEligible =
          !countOnly && isHistogramEligibleField(fieldDef);
        const resolved = resolvedFields[fieldName];
        const hasDefault = resolved?.hasDefault === true;
        const defaultValue = hasDefault ? resolved?.defaultValue : undefined;

        let deviations = 0;
        const histogramKeys: string[] = [];
        if ('value' in sample) {
          // Server-derived deviation: the resolved default is the authority.
          if (!hasDefault || !usageValuesEqual(sample.value, defaultValue)) {
            deviations += 1;
          }
          if (histogramEligible) {
            const key = serializeHistogramSample(fieldDef, sample.value);
            if (key !== null) {
              histogramKeys.push(key);
            }
          }
        } else if (sample.matchedDefault !== true) {
          // Value-less entry: only the deviation bit is taken from the
          // client hint (see the bounded-trust note above).
          deviations += 1;
        }

        await this.mergeIntoBucket({
          objectRef,
          fieldName,
          tenantId,
          period,
          userId,
          submissionCount: 1,
          deviationCount: deviations,
          histogramKeys,
        });
        accepted += 1;
      }
    }

    return { accepted, dropped };
  }

  /**
   * The defaults the CALLER's forms would have prefilled — the deviation
   * authority. Resolved for the ambient `(tenant, user)` identity (the
   * resolver's own TTL cache keeps repeat batches cheap).
   *
   * Ingestion is fire-and-forget, so a stored-layer read failure degrades to
   * the CODE-SEED-only resolution (no db) rather than failing the request;
   * `null` (both attempts failed) makes the caller drop the group.
   */
  private async resolveDefaultsForCaller(
    objectRef: string,
    tenantId: string,
    userId: string,
  ): Promise<Record<string, ResolvedFieldPolicy> | undefined | null> {
    // Dynamic import mirrors the resolver seams elsewhere in this package
    // (the resolver statically imports the policy collection).
    const { resolveFieldPolicy } = await import('../field-policy-resolver.js');
    try {
      const resolved = await resolveFieldPolicy(objectRef, {
        tenantId,
        userId,
        db: this.db,
      });
      return resolved.fields;
    } catch {
      try {
        const seedOnly = await resolveFieldPolicy(objectRef, {
          tenantId,
          userId,
        });
        return seedOnly.fields;
      } catch {
        return null;
      }
    }
  }

  /**
   * Counter rows within a period window (inclusive bounds, lexicographic ISO
   * day comparison), optionally restricted to one tenant — the read the
   * suggestion-generation job consumes.
   */
  async listWindow(options: {
    fromPeriod: string;
    toPeriod?: string;
    tenantId?: string | null;
  }): Promise<FieldUsageCounter[]> {
    const where: Record<string, unknown> = {
      'period >=': options.fromPeriod,
    };
    if (options.toPeriod) {
      where['period <='] = options.toPeriod;
    }
    if (options.tenantId) {
      where.tenantId = options.tenantId;
    }
    return this.list({ where, orderBy: 'period ASC' });
  }

  /**
   * Idempotent read-modify-write merge into the deterministic day bucket.
   * Counters are approximate by design: concurrent cross-process merges may
   * lose an increment (documented on the model), while the deterministic id
   * plus the natural-key unique index keep concurrent creates converging on
   * one row.
   */
  private async mergeIntoBucket(options: {
    objectRef: string;
    fieldName: string;
    tenantId: string;
    period: string;
    userId: string;
    /** Every observed submission (the dominance denominator). */
    submissionCount: number;
    /** Submissions that differed from the resolved default. */
    deviationCount: number;
    histogramKeys: string[];
  }): Promise<void> {
    const id = await fieldUsageCounterId(
      options.tenantId,
      options.objectRef,
      options.fieldName,
      options.period,
    );

    const existing = await this.get(id);
    const counter =
      existing ??
      new FieldUsageCounter({
        db: this.db,
        id,
        objectRef: options.objectRef,
        fieldName: options.fieldName,
        tenantId: options.tenantId,
        period: options.period,
      });

    counter.submissionCount += options.submissionCount;
    counter.setCount += options.deviationCount;
    // Distinct users track the PROMOTE signal: only a caller who actually set
    // a non-default value counts as "actively filling this field in".
    if (options.deviationCount > 0) {
      counter.addDistinctUser(options.userId);
    }
    for (const key of options.histogramKeys) {
      counter.recordHistogramSample(key);
    }
    if (!existing) {
      await counter.initialize();
    }
    await counter.save();
  }
}

/** Internal only — this table has no generated surface. */
@smrt({
  conflictColumns: [
    'tenant_id',
    'user_id',
    'object_ref',
    'field_name',
    'period',
  ],
  api: false,
  cli: false,
  mcp: false,
})
class FieldUsageReportReceiptCollection extends SmrtCollection<FieldUsageReportReceipt> {
  static readonly _itemClass = FieldUsageReportReceipt;

  async claim(options: {
    tenantId: string;
    userId: string;
    objectRef: string;
    fieldName: string;
    period: string;
  }): Promise<boolean> {
    const id = await fieldUsageReportReceiptId(
      options.tenantId,
      options.userId,
      options.objectRef,
      options.fieldName,
      options.period,
    );
    if (await this.get(id)) return false;
    try {
      await this.create({ ...options, id, _insertOnly: true });
      return true;
    } catch (error) {
      // Only a receipt that now exists proves another request won the race;
      // validation/schema/connection failures must remain visible.
      if (await this.get(id)) return false;
      throw error;
    }
  }
}

/**
 * Deterministic bucket row id (the TenantUsageMetric `recordUsage` precedent):
 * SHA-256 over the natural key, formatted as a v5-style UUID so the id column
 * stays native UUID on PostgreSQL/DuckDB.
 */
export async function fieldUsageCounterId(
  tenantId: string,
  objectRef: string,
  fieldName: string,
  period: string,
): Promise<string> {
  return deterministicFieldsUuid([
    'field-usage-counter',
    tenantId,
    objectRef,
    fieldName,
    period,
  ]);
}

/** Deterministic receipt id for the durable once-per-day contribution rule. */
export async function fieldUsageReportReceiptId(
  tenantId: string,
  userId: string,
  objectRef: string,
  fieldName: string,
  period: string,
): Promise<string> {
  return deterministicFieldsUuid([
    'field-usage-report-receipt',
    tenantId,
    userId,
    objectRef,
    fieldName,
    period,
  ]);
}

/** Mirrors the resolver's policy-addressable exclusions, plus transient. */
function isUsageAddressableField(field: RegisteredFieldInfo): boolean {
  if (field._meta?.__smrtSystemField === true) {
    return false;
  }
  if (
    field.type === 'oneToMany' ||
    field.type === 'manyToMany' ||
    field.type === 'meta'
  ) {
    return false;
  }
  return !isTransientField(field);
}

/**
 * Histogram eligibility (#2051 pin): ONLY low-cardinality field types —
 * `boolean` and reference ids (`foreignKey` / `crossPackageRef`). Free text
 * is NEVER histogrammed, even when non-sensitive (PII risk); numeric,
 * datetime, and json fields are count-only too.
 */
export function isHistogramEligibleField(field: RegisteredFieldInfo): boolean {
  return (
    field.type === 'boolean' ||
    field.type === 'foreignKey' ||
    field.type === 'crossPackageRef'
  );
}

/**
 * Serialize one sample into a histogram key, type-checked against the field:
 * booleans must be real booleans (`'true'` / `'false'` keys); reference ids
 * must be STORABLE ids for the field — `isStorableReferenceId` applies the same
 * native-UUID / `idType: 'text'` rule stored defaults are held to, within the
 * bounded key length. Anything else is skipped (the submission still counts —
 * count-only for that sample).
 *
 * The reference check is load-bearing, not cosmetic: recording an unstorable
 * id would let an authenticated caller poison a histogram, win dominance with
 * it, and produce a `default` suggestion whose write is then rejected by the
 * same rule — turning a bad sample into a stuck generation candidate.
 */
export function serializeHistogramSample(
  field: RegisteredFieldInfo,
  value: unknown,
): string | null {
  if (field.type === 'boolean') {
    return typeof value === 'boolean' ? String(value) : null;
  }
  if (
    isStorableReferenceId(field, value) &&
    value.length <= MAX_VALUE_HISTOGRAM_KEY_LENGTH
  ) {
    return value;
  }
  return null;
}

/** Decode a histogram key back into the typed value it was recorded from. */
export function decodeHistogramKey(
  field: RegisteredFieldInfo,
  key: string,
): unknown {
  if (field.type === 'boolean') {
    return key === 'true';
  }
  return key;
}

function validateEntriesInput(
  rawEntries: FieldUsageReportEntry[] | undefined,
): FieldUsageReportEntry[] {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new Error(
      'reportUsage requires a non-empty "entries" array of ' +
        '{ objectRef, fieldName, value?, matchedDefault? } samples',
    );
  }
  if (rawEntries.length > MAX_USAGE_REPORT_ENTRIES) {
    throw new Error(
      `reportUsage accepts at most ${MAX_USAGE_REPORT_ENTRIES} entries ` +
        `per call (got ${rawEntries.length})`,
    );
  }
  for (const entry of rawEntries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.objectRef !== 'string' ||
      entry.objectRef.trim() === '' ||
      typeof entry.fieldName !== 'string' ||
      entry.fieldName.trim() === ''
    ) {
      throw new Error(
        'reportUsage entries must carry non-empty objectRef and fieldName strings',
      );
    }
  }
  return rawEntries;
}

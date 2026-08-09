/**
 * #2051 usage ingestion: the batched `reportUsage` action and the counter
 * model's bounded-approximation mechanics.
 *
 * The security AC lives here: sensitive and `readPermission`-gated fields are
 * COUNT-ONLY — their raw values never persist anywhere in usage data. No
 * production model uses `readPermission` yet, so the gated fixture is created
 * here (the #2047 batch-test precedent).
 */

import { randomUUID } from 'node:crypto';
import {
  crossPackageRef,
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  resetTenancy,
  setupTestTenancy,
  TenantIsolationError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Side-effect import: registers smrt-users' classes (Tenant) so the default
// resolution inside ingestion can walk the tenant table.
import '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
import {
  FieldUsageCounterCollection,
  fieldUsageCounterId,
  MAX_USAGE_REPORT_ENTRIES,
  usageValuesEqual as serverUsageValuesEqual,
} from './collections/FieldUsageCounterCollection.js';
import {
  FieldUsageCounter,
  fieldUsagePeriodForDate,
  MAX_DISTINCT_USERS_PER_BUCKET,
  MAX_VALUE_HISTOGRAM_BUCKETS,
} from './models/FieldUsageCounter.js';
import { MANAGE_FIELD_POLICY_PERMISSION } from './permissions.js';
import type { FieldUsageReportEntry } from './types.js';
import { runFieldPolicySuggestionGeneration } from './usage-learning.js';

@smrt({
  packageName: '@test/smrt-fields-usage',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
})
class UsageCaptureDoc extends SmrtObject {
  @field({ ui: { basic: true } })
  title: string = '';

  // No recorded code default: a bare `= false` initializer is NOT captured in
  // the manifest (only an explicit `default:` option is), so every non-blank
  // submission of this field is a deviation.
  @field({ type: 'boolean' })
  featured: boolean = false;

  // Explicit default — the P1 dominance scenario: `false` submissions match
  // the default, `true` submissions deviate.
  @field({ type: 'boolean', default: false })
  optedIn: boolean = false;

  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  ownerId: string | null = null;

  // Text-id reference: its legitimate ids are arbitrary strings, including
  // prototype-shaped ones like `constructor` / `toString` / `__proto__`.
  @crossPackageRef('@happyvertical/smrt-users:User', {
    nullable: true,
    idType: 'text',
  })
  externalRef: string | null = null;

  @field({ sensitive: true })
  taxId: string = '';

  // readPermission fixture: no production model uses the option yet, so the
  // count-only contract is pinned here (#2051 pin 7).
  @field({ readPermission: 'fields.usage.read' })
  gatedNotes: string = '';

  @field({ transient: true })
  derived: string = '';
}

function fixtureRef(): string {
  const registered = ObjectRegistry.getClassByConstructor(UsageCaptureDoc);
  if (!registered?.qualifiedName) {
    throw new Error('UsageCaptureDoc is not registered with a qualified name');
  }
  return registered.qualifiedName;
}

describe('FieldUsageCounterCollection.reportUsage (#2051)', () => {
  let db: DatabaseInterface;
  let counters: FieldUsageCounterCollection;
  let objectRef: string;
  let tenantId: string;
  let userId: string;

  const report = (
    entries: FieldUsageReportEntry[],
    identity: { tenantId?: string; userId?: string | null } = {},
  ) => {
    const invoke = (samples: FieldUsageReportEntry[], sampleUserId?: string) =>
      withTenant(
        {
          tenantId: identity.tenantId ?? tenantId,
          ...(identity.userId === null
            ? {}
            : { userId: sampleUserId ?? identity.userId ?? userId }),
          permissions: new Set<string>(),
        },
        () => counters.reportUsage({ entries: samples }),
      );

    // Most tests exercise one authenticated form submission containing many
    // DIFFERENT fields. For repeated samples of the same field, model the
    // distinct members those aggregates represent — one member can now
    // contribute only once per field/day by design.
    if (entries.length === 0 || entries.length > MAX_USAGE_REPORT_ENTRIES) {
      return invoke(entries);
    }
    const seen = new Set<string>();
    if (
      entries.every(
        (entry) => !seen.has(entry.fieldName) && !!seen.add(entry.fieldName),
      )
    ) {
      return invoke(entries);
    }
    return Promise.all(
      entries.map((entry, index) =>
        invoke(
          [entry],
          index === 0 || identity.userId !== undefined
            ? (identity.userId ?? userId)
            : randomUUID(),
        ),
      ),
    ).then((results) => ({
      accepted: results.reduce((sum, result) => sum + result.accepted, 0),
      dropped: results.reduce((sum, result) => sum + result.dropped, 0),
    }));
  };

  beforeEach(async () => {
    setupTestTenancy();
    clearFieldPolicyCache();
    // `FieldPolicy` + `Tenant` back the server-side default resolution the
    // deviation bit is derived from (#2051 round-2: dominance needs a real
    // denominator, so ingestion must know what the default was).
    db = await getTestDatabase({
      classes: [
        'FieldUsageCounter',
        'FieldUsageReportReceipt',
        'FieldPolicySuggestion',
        'FieldPolicy',
        'Tenant',
      ],
    });
    counters = await FieldUsageCounterCollection.create({ db });
    objectRef = fixtureRef();
    tenantId = randomUUID();
    userId = randomUUID();
  });

  afterEach(async () => {
    clearFieldPolicyCache();
    resetTenancy();
    if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
      await (db as unknown as { close: () => Promise<void> }).close();
    }
  });

  it('fails closed without an ambient tenant context', async () => {
    await expect(
      counters.reportUsage({
        entries: [{ objectRef, fieldName: 'title', value: 'x' }],
      }),
    ).rejects.toThrow(TenantIsolationError);
    expect(await counters.list({})).toHaveLength(0);
  });

  it('records counts for the ambient identity only — the body cannot attribute', async () => {
    const result = await report([
      { objectRef, fieldName: 'title', value: 'Hello' },
    ]);
    expect(result).toEqual({ accepted: 1, dropped: 0 });

    const rows = await counters.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantId);
    expect(rows[0].period).toBe(fieldUsagePeriodForDate(new Date()));
    expect(rows[0].submissionCount).toBe(1);
    expect(rows[0].setCount).toBe(1);
    expect(rows[0].getDistinctUserIds()).toEqual([userId]);
    expect(rows[0].distinctUserCount).toBe(1);
    // Free text is NEVER histogrammed, even when non-sensitive (PII risk).
    expect(rows[0].valueHistogram).toBeNull();
  });

  it('fails closed for a tenant WITHOUT an authenticated user', async () => {
    // Middleware that resolves the tenant from host/header alone leaves no
    // ambient user: such a caller could inflate counters without bound and
    // distinctUsers would be meaningless, so ingestion refuses it.
    await expect(
      report([{ objectRef, fieldName: 'title', value: 'anon' }], {
        userId: null,
      }),
    ).rejects.toThrow(/requires an ambient AUTHENTICATED user/);
    expect(await counters.list({})).toHaveLength(0);

    // The same batch from an authenticated principal is accepted.
    const result = await report([
      { objectRef, fieldName: 'title', value: 'signed in' },
    ]);
    expect(result).toEqual({ accepted: 1, dropped: 0 });
    expect(await counters.list({})).toHaveLength(1);
  });

  it('separates total submissions from deviations against the RESOLVED default', async () => {
    // `optedIn` declares `default: false`, so `false` submissions are NOT
    // deviations while `true` submissions are.
    await report([
      { objectRef, fieldName: 'optedIn', value: false },
      { objectRef, fieldName: 'optedIn', value: false },
      { objectRef, fieldName: 'optedIn', value: true },
    ]);

    const [row] = await counters.list({ where: { fieldName: 'optedIn' } });
    expect(row.submissionCount).toBe(3);
    expect(row.setCount).toBe(1);
    // The histogram covers ALL submissions — that is the dominance denominator.
    expect(row.getValueHistogram()).toEqual({ false: 2, true: 1 });
    expect(row.isLegacyBucket()).toBe(false);

    // A field with NO recorded code default has nothing to deviate from, so
    // every submission counts as one (documented consequence).
    await report([{ objectRef, fieldName: 'featured', value: false }]);
    const [bare] = await counters.list({ where: { fieldName: 'featured' } });
    expect(bare.submissionCount).toBe(1);
    expect(bare.setCount).toBe(1);
  });

  it('re-derives deviations from an ORG default, never from the client', async () => {
    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        const policies = await FieldPolicyCollection.create({ db });
        await policies.create({
          objectRef,
          fieldName: 'optedIn',
          scopeType: 'tenant',
          tenantId,
          defaultValue: JSON.stringify(true),
        });
      },
    );
    clearFieldPolicyCache();

    // With the org default now `true`, `true` submissions stop being
    // deviations and `false` ones start being them — the opposite of the code
    // seed, and of what a stale client claims in these payloads.
    await report([
      { objectRef, fieldName: 'optedIn', value: true, matchedDefault: false },
      { objectRef, fieldName: 'optedIn', value: false, matchedDefault: true },
    ]);

    const [row] = await counters.list({ where: { fieldName: 'optedIn' } });
    expect(row.submissionCount).toBe(2);
    expect(row.setCount).toBe(1);
    expect(row.getValueHistogram()).toEqual({ true: 1, false: 1 });
  });

  it('counts value-less entries as submissions, honoring matchedDefault for the bit only', async () => {
    await report([
      { objectRef, fieldName: 'optedIn', matchedDefault: true },
      { objectRef, fieldName: 'optedIn', matchedDefault: true },
      { objectRef, fieldName: 'optedIn' },
    ]);

    const [row] = await counters.list({ where: { fieldName: 'optedIn' } });
    expect(row.submissionCount).toBe(3);
    expect(row.setCount).toBe(1);
    // No value ⇒ no histogram, so a value-less batch can never drive a
    // `default` suggestion.
    expect(row.valueHistogram).toBeNull();
  });

  it('attributes distinct users only when the caller actually deviated', async () => {
    const defaultOnlyUser = randomUUID();
    await report([{ objectRef, fieldName: 'optedIn', value: false }], {
      userId: defaultOnlyUser,
    });
    await report([{ objectRef, fieldName: 'optedIn', value: true }]);

    const [row] = await counters.list({ where: { fieldName: 'optedIn' } });
    expect(row.submissionCount).toBe(2);
    expect(row.setCount).toBe(1);
    expect(row.getDistinctUserIds()).toEqual([userId]);
  });

  it('keeps sensitive and readPermission-gated fields COUNT-ONLY: values never persist', async () => {
    const secret = 'TAX-123-45-6789';
    const gated = 'privileged-note';
    await report([
      { objectRef, fieldName: 'taxId', value: secret },
      { objectRef, fieldName: 'gatedNotes', value: gated },
    ]);

    const rows = await counters.list({});
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.submissionCount).toBe(1);
      expect(row.setCount).toBe(1);
      expect(row.valueHistogram).toBeNull();
      expect(row.valueHistogramOverflowed).toBe(false);
    }

    // Belt-and-braces: the raw values appear NOWHERE in the persisted rows.
    const raw = await db.query('SELECT * FROM _smrt_field_usage_counters');
    const dump = JSON.stringify(
      Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? []),
    );
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(gated);
  });

  it('histograms only low-cardinality types (boolean, reference ids)', async () => {
    const owner = randomUUID();
    await report([
      { objectRef, fieldName: 'featured', value: true },
      { objectRef, fieldName: 'featured', value: true },
      { objectRef, fieldName: 'featured', value: false },
      { objectRef, fieldName: 'ownerId', value: owner },
      { objectRef, fieldName: 'title', value: 'free text stays out' },
    ]);

    const rows = await counters.list({});
    const byField = new Map(rows.map((row) => [row.fieldName, row]));

    expect(byField.get('featured')?.getValueHistogram()).toEqual({
      true: 2,
      false: 1,
    });
    // `featured` has no recorded code default, so all three submissions
    // deviate; the histogram still covers every one of them.
    expect(byField.get('featured')?.submissionCount).toBe(3);
    expect(byField.get('featured')?.setCount).toBe(3);
    expect(byField.get('ownerId')?.getValueHistogram()).toEqual({
      [owner]: 1,
    });
    expect(byField.get('title')?.valueHistogram).toBeNull();
  });

  it('type-checks histogram samples (junk counts but is not recorded)', async () => {
    await report([
      { objectRef, fieldName: 'featured', value: 'not-a-boolean' },
      { objectRef, fieldName: 'featured', value: true },
      { objectRef, fieldName: 'ownerId', value: 42 },
    ]);

    const rows = await counters.list({});
    const byField = new Map(rows.map((row) => [row.fieldName, row]));
    // Both count as submissions and as deviations (neither equals `false`),
    // but only the real boolean is histogrammed.
    expect(byField.get('featured')?.submissionCount).toBe(2);
    expect(byField.get('featured')?.setCount).toBe(2);
    expect(byField.get('featured')?.getValueHistogram()).toEqual({ true: 1 });
    expect(byField.get('ownerId')?.submissionCount).toBe(1);
    expect(byField.get('ownerId')?.setCount).toBe(1);
    expect(byField.get('ownerId')?.valueHistogram).toBeNull();
  });

  it('drops unknown and non-usage-addressable entries without failing the batch', async () => {
    const result = await report([
      { objectRef, fieldName: 'title', value: 'kept' },
      { objectRef, fieldName: 'derived', value: 'transient out' },
      { objectRef, fieldName: 'nope', value: 'unknown field' },
      { objectRef: '@test/nowhere:Nope', fieldName: 'title', value: 'x' },
    ]);
    expect(result).toEqual({ accepted: 1, dropped: 3 });

    const rows = await counters.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0].fieldName).toBe('title');
  });

  it('merges same-day reports into one deterministic bucket per field', async () => {
    const otherUser = randomUUID();
    await report([{ objectRef, fieldName: 'featured', value: true }]);
    await report([{ objectRef, fieldName: 'featured', value: true }], {
      userId: otherUser,
    });

    const rows = await counters.list({});
    expect(rows).toHaveLength(1);
    const expectedId = await fieldUsageCounterId(
      tenantId,
      objectRef,
      'featured',
      fieldUsagePeriodForDate(new Date()),
    );
    expect(rows[0].id).toBe(expectedId);
    expect(rows[0].submissionCount).toBe(2);
    expect(rows[0].setCount).toBe(2);
    expect(new Set(rows[0].getDistinctUserIds())).toEqual(
      new Set([userId, otherUser]),
    );
    expect(rows[0].getValueHistogram()).toEqual({ true: 2 });
  });

  it('lets one member contribute one field sample per day, blocking threshold inflation', async () => {
    const repeated = { objectRef, fieldName: 'optedIn', value: true };
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await withTenant(
        { tenantId, userId, permissions: new Set<string>() },
        () => counters.reportUsage({ entries: [repeated] }),
      );
    }

    const [row] = await counters.list({ where: { fieldName: 'optedIn' } });
    expect(row.submissionCount).toBe(1);
    expect(row.setCount).toBe(1);
    expect(row.getValueHistogram()).toEqual({ true: 1 });

    // Even deliberately permissive generation thresholds cannot turn one
    // repeated caller into a dominant-value/default suggestion.
    const result = await runFieldPolicySuggestionGeneration({
      db,
      minSetCount: 2,
      defaultDominanceRatio: 0.5,
      minDistinctUsers: 2,
    });
    expect(result.created).toBe(0);
  });

  it('bounds the batch and validates entry shape', async () => {
    await expect(report([])).rejects.toThrow(/non-empty "entries"/);
    // Input validation precedes the context gate, so no identity is needed.
    await expect(counters.reportUsage({})).rejects.toThrow(
      /non-empty "entries"/,
    );
    await expect(report([{ objectRef, fieldName: '' }])).rejects.toThrow(
      /non-empty objectRef and fieldName/,
    );

    const tooMany = Array.from({ length: 101 }, () => ({
      objectRef,
      fieldName: 'title',
      value: 'x',
    }));
    await expect(report(tooMany)).rejects.toThrow(/at most 100 entries/);
  });

  it('compares submitted values deterministically for server-side deviations', () => {
    for (const [a, b] of [
      [1, 1],
      [0, false],
      ['x', 'x'],
      [{ a: 1 }, { a: 1 }],
      [null, undefined],
      [new Date('2026-01-01'), '2026-01-01T00:00:00.000Z'],
    ] as Array<[unknown, unknown]>) {
      expect(serverUsageValuesEqual(a, b)).toBe(
        a === b || JSON.stringify(a) === JSON.stringify(b),
      );
    }
  });

  it('never records an unstorable reference id in a histogram (P1 regression)', async () => {
    // A UUID-backed reference column would reject this id at insert time, so a
    // recorded histogram entry could win dominance and then be refused at
    // suggestion-write time. The submission still COUNTS; only the value is
    // dropped.
    const validOwner = randomUUID();
    const result = await report([
      { objectRef, fieldName: 'ownerId', value: 'not-a-uuid' },
      { objectRef, fieldName: 'ownerId', value: '' },
      {
        objectRef,
        fieldName: 'ownerId',
        value: `${validOwner}-overlong-suffix`,
      },
      { objectRef, fieldName: 'ownerId', value: validOwner },
    ]);
    expect(result).toEqual({ accepted: 4, dropped: 0 });

    const [row] = await counters.list({ where: { fieldName: 'ownerId' } });
    expect(row.submissionCount).toBe(4);
    expect(row.setCount).toBe(4);
    expect(row.getValueHistogram()).toEqual({ [validOwner]: 1 });
    const dump = JSON.stringify(row.getValueHistogram());
    expect(dump).not.toContain('not-a-uuid');
  });

  it('counts prototype-shaped text ids as ordinary buckets (P2 regression)', async () => {
    // On a plain object these read back as inherited members (a missing bucket
    // looks present) and `__proto__` hits the prototype setter instead of
    // creating an own key — both silently corrupt counts.
    await report([
      { objectRef, fieldName: 'externalRef', value: 'constructor' },
      { objectRef, fieldName: 'externalRef', value: 'constructor' },
      { objectRef, fieldName: 'externalRef', value: '__proto__' },
      { objectRef, fieldName: 'externalRef', value: 'toString' },
      { objectRef, fieldName: 'externalRef', value: 'hasOwnProperty' },
      { objectRef, fieldName: 'externalRef', value: 'ordinary-id' },
    ]);

    const [row] = await counters.list({ where: { fieldName: 'externalRef' } });
    const histogram = row.getValueHistogram();
    // NOTE: the expectation is built with `Object.fromEntries`, never an object
    // literal — `{ __proto__: 1 }` sets the prototype instead of defining a
    // key, which is the same hazard this test guards in the production path.
    expect(histogram).toEqual(
      Object.fromEntries([
        ['constructor', 2],
        ['__proto__', 1],
        ['toString', 1],
        ['hasOwnProperty', 1],
        ['ordinary-id', 1],
      ]),
    );
    // Own keys, not inherited members — and the counts survive the JSON
    // round-trip through the column.
    expect(Object.keys(histogram).sort()).toEqual([
      '__proto__',
      'constructor',
      'hasOwnProperty',
      'ordinary-id',
      'toString',
    ]);
    for (const key of Object.keys(histogram)) {
      expect(Object.hasOwn(histogram, key)).toBe(true);
      expect(typeof histogram[key]).toBe('number');
    }
    // A null-prototype map: no inherited members to shadow a missing bucket.
    expect(Object.getPrototypeOf(histogram)).toBeNull();
    expect(row.submissionCount).toBe(6);
  });

  it('rejects cross-tenant counter writes from an ambient context', async () => {
    const foreign = new FieldUsageCounter({
      db,
      objectRef,
      fieldName: 'title',
      tenantId: randomUUID(),
      period: fieldUsagePeriodForDate(new Date()),
    });
    await expect(
      withTenant(
        { tenantId, userId, permissions: new Set<string>() },
        async () => {
          foreign.setCount = 1;
          await foreign.save();
        },
      ),
    ).rejects.toThrow(TenantIsolationError);
  });
});

describe('FieldUsageCounter persisted ownership (#2051 P2)', () => {
  let db: DatabaseInterface;
  let counters: FieldUsageCounterCollection;
  let objectRef: string;
  let foreignTenant: string;
  let callerTenant: string;
  let bucketId: string;

  beforeEach(async () => {
    setupTestTenancy();
    clearFieldPolicyCache();
    db = await getTestDatabase({
      classes: ['FieldUsageCounter', 'FieldPolicy', 'Tenant'],
    });
    counters = await FieldUsageCounterCollection.create({ db });
    objectRef = fixtureRef();
    foreignTenant = randomUUID();
    callerTenant = randomUUID();
    const period = fieldUsagePeriodForDate(new Date());
    bucketId = await fieldUsageCounterId(
      foreignTenant,
      objectRef,
      'title',
      period,
    );
    // Seeded by trusted execution (no ambient context), as the ingestion path
    // and learning jobs do.
    await counters.create({
      id: bucketId,
      objectRef,
      fieldName: 'title',
      tenantId: foreignTenant,
      period,
      submissionCount: 7,
      setCount: 7,
    });
  });

  afterEach(async () => {
    clearFieldPolicyCache();
    resetTenancy();
    if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
      await (db as unknown as { close: () => Promise<void> }).close();
    }
  });

  it('refuses to adopt a foreign row by re-stamping tenantId', async () => {
    await expect(
      withTenant(
        {
          tenantId: callerTenant,
          userId: randomUUID(),
          permissions: new Set(),
        },
        async () => {
          // Bucket ids are deterministic and the helper is exported, so a
          // foreign row is trivially addressable: load it, re-stamp the tenant,
          // and an in-memory-only check would happily save it.
          const foreign = await counters.get(bucketId);
          if (!foreign) throw new Error('fixture row missing');
          foreign.tenantId = callerTenant;
          foreign.setCount = 999;
          await foreign.save();
        },
      ),
    ).rejects.toThrow(TenantIsolationError);

    const untouched = await counters.get(bucketId);
    expect(untouched?.tenantId).toBe(foreignTenant);
    expect(untouched?.setCount).toBe(7);
  });

  it('refuses to delete a foreign row, re-stamped or not', async () => {
    await expect(
      withTenant(
        {
          tenantId: callerTenant,
          userId: randomUUID(),
          permissions: new Set(),
        },
        async () => {
          const foreign = await counters.get(bucketId);
          if (!foreign) throw new Error('fixture row missing');
          await foreign.delete();
        },
      ),
    ).rejects.toThrow(TenantIsolationError);

    await expect(
      withTenant(
        {
          tenantId: callerTenant,
          userId: randomUUID(),
          permissions: new Set(),
        },
        async () => {
          const foreign = await counters.get(bucketId);
          if (!foreign) throw new Error('fixture row missing');
          foreign.tenantId = callerTenant;
          await foreign.delete();
        },
      ),
    ).rejects.toThrow(TenantIsolationError);

    expect(await counters.get(bucketId)).not.toBeNull();
  });

  it('still allows the owning tenant and trusted execution', async () => {
    await withTenant(
      { tenantId: foreignTenant, userId: randomUUID(), permissions: new Set() },
      async () => {
        const own = await counters.get(bucketId);
        if (!own) throw new Error('fixture row missing');
        own.setCount = 8;
        await own.save();
      },
    );
    expect((await counters.get(bucketId))?.setCount).toBe(8);

    const trusted = await counters.get(bucketId);
    if (!trusted) throw new Error('fixture row missing');
    await trusted.delete();
    expect(await counters.get(bucketId)).toBeNull();
  });
});

describe('FieldUsageCounter bounded approximations', () => {
  it('caps the distinct-user set with an honest overflow marker', () => {
    const counter = new FieldUsageCounter();
    for (let i = 0; i < MAX_DISTINCT_USERS_PER_BUCKET; i++) {
      counter.addDistinctUser(`user-${i}`);
    }
    expect(counter.distinctUserCount).toBe(MAX_DISTINCT_USERS_PER_BUCKET);
    expect(counter.distinctUsersOverflowed).toBe(false);

    counter.addDistinctUser('one-too-many');
    expect(counter.distinctUserCount).toBe(MAX_DISTINCT_USERS_PER_BUCKET);
    expect(counter.distinctUsersOverflowed).toBe(true);
    expect(counter.getDistinctUserIds()).not.toContain('one-too-many');

    // Re-adding a KNOWN user never trips the marker.
    const before = counter.distinctUsersOverflowed;
    counter.addDistinctUser('user-0');
    expect(counter.distinctUsersOverflowed).toBe(before);
  });

  it('caps histogram buckets while existing keys keep counting', () => {
    const counter = new FieldUsageCounter();
    for (let i = 0; i < MAX_VALUE_HISTOGRAM_BUCKETS; i++) {
      counter.recordHistogramSample(`value-${i}`);
    }
    counter.recordHistogramSample('overflow-key');
    expect(counter.valueHistogramOverflowed).toBe(true);
    expect(counter.getValueHistogram()['overflow-key']).toBeUndefined();

    counter.recordHistogramSample('value-0');
    expect(counter.getValueHistogram()['value-0']).toBe(2);
  });

  it('keeps prototype-shaped histogram keys distinct through the round trip', () => {
    const counter = new FieldUsageCounter();
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf']) {
      counter.recordHistogramSample(key);
      counter.recordHistogramSample(key);
    }
    expect(counter.getValueHistogram()).toEqual(
      Object.fromEntries([
        ['constructor', 2],
        ['__proto__', 2],
        ['toString', 2],
        ['valueOf', 2],
      ]),
    );

    // Re-hydrating from the serialized column preserves them (JSON.parse
    // materializes `__proto__` as an ordinary own property).
    const rehydrated = new FieldUsageCounter({
      valueHistogram: counter.valueHistogram,
    });
    const rehydratedHistogram = rehydrated.getValueHistogram();
    // Read through a variable key: on this null-prototype map `__proto__` is
    // ordinary DATA, but the literal accessor is (rightly) lint-flagged.
    const protoKey = '__proto__';
    expect(rehydratedHistogram[protoKey]).toBe(2);
    expect(rehydratedHistogram.constructor).toBe(2);
    expect(Object.hasOwn(rehydratedHistogram, protoKey)).toBe(true);
    expect(Object.getPrototypeOf(rehydrated.getValueHistogram())).toBeNull();

    // The bucket cap counts real buckets, not prototype members.
    expect(Object.keys(rehydrated.getValueHistogram())).toHaveLength(4);
    expect(counter.valueHistogramOverflowed).toBe(false);
  });

  it('parses junk JSON columns as empty (guarded helpers)', () => {
    const counter = new FieldUsageCounter({
      distinctUserIds: '{not json',
      valueHistogram: '[definitely not]',
    });
    expect(counter.getDistinctUserIds()).toEqual([]);
    expect(counter.getValueHistogram()).toEqual({});
  });
});

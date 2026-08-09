/**
 * #2051 learning jobs: threshold-driven suggestion generation (evidence,
 * dedup, dismissal cool-down), counter/suggestion retention, the schedule
 * target contract, and the dormant AgentSchedule installer.
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Side-effect import: registers smrt-users' classes (Tenant) for the
// resolver's default hierarchy loader.
import '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
import { FieldPolicySuggestionCollection } from './collections/FieldPolicySuggestionCollection.js';
import {
  FieldUsageCounterCollection,
  fieldUsageCounterId,
} from './collections/FieldUsageCounterCollection.js';
import { resolveFieldPolicy } from './field-policy-resolver.js';
import { ACTIVE_SUGGESTION_KEY } from './models/FieldPolicySuggestion.js';
import { fieldUsagePeriodForDate } from './models/FieldUsageCounter.js';
import { MANAGE_FIELD_POLICY_PERMISSION } from './permissions.js';
import {
  FIELD_USAGE_SUGGESTION_DEFAULTS,
  FieldUsageLearningAgent,
  MAX_REPORTED_GROUP_FAILURES,
  pruneFieldPolicySuggestions,
  pruneFieldUsageCounters,
  pruneFieldUsageReportReceipts,
  runFieldPolicySuggestionGeneration,
  runFieldUsageMaintenance,
} from './usage-learning.js';
import {
  DEFAULT_FIELD_USAGE_MAINTENANCE_CRON,
  DEFAULT_FIELD_USAGE_SUGGESTION_CRON,
  ensureFieldUsageLearningSchedules,
  FIELD_USAGE_LEARNING_AGENT_TYPE,
  FIELD_USAGE_MAINTENANCE_METHOD,
  FIELD_USAGE_SUGGESTION_METHOD,
  type FieldUsageAgentsModule,
  fieldUsageScheduleId,
} from './usage-schedules.js';
import { isMissingWorkspaceDependency } from './users-module.js';

@smrt({
  packageName: '@test/smrt-fields-learning',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
})
class LearningDoc extends SmrtObject {
  @field({ ui: { basic: true } })
  headline: string = '';

  // Unmarked while headline is basic ⇒ 'advanced': the promote candidate.
  @field()
  region: string = '';

  // Histogram-eligible default candidate; also advanced (unmarked). No
  // recorded code default (a bare `= false` initializer is not captured in the
  // manifest), so any submitted value is a deviation.
  @field({ type: 'boolean' })
  featured: boolean = false;

  // Explicit `default: false` — the P1 dominance scenario: a value seen only
  // in deviations must NOT look dominant against a sea of default submissions.
  @field({ type: 'boolean', default: false })
  optedIn: boolean = false;

  // UUID-backed reference: the poisoned-histogram fixture (a non-UUID id is
  // refused by the FieldPolicy rail at suggestion-write time).
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  ownerRef: string | null = null;

  // Text-id reference: arbitrary ids are legitimate here, including
  // prototype-shaped ones.
  @crossPackageRef('@happyvertical/smrt-users:User', {
    nullable: true,
    idType: 'text',
  })
  externalOwner: string | null = null;
}

function fixtureRef(): string {
  const registered = ObjectRegistry.getClassByConstructor(LearningDoc);
  if (!registered?.qualifiedName) {
    throw new Error('LearningDoc is not registered with a qualified name');
  }
  return registered.qualifiedName;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgoPeriod(days: number): string {
  return fieldUsagePeriodForDate(new Date(Date.now() - days * DAY_MS));
}

describe('field usage learning jobs (#2051)', () => {
  let db: DatabaseInterface;
  let counters: FieldUsageCounterCollection;
  let suggestions: FieldPolicySuggestionCollection;
  let policies: FieldPolicyCollection;
  let objectRef: string;
  let tenantId: string;

  /** Seed a counter bucket through the trusted (no-context) path. */
  async function seedCounter(options: {
    fieldName: string;
    daysAgo?: number;
    setCount: number;
    /** Total submissions; defaults to `setCount` (all deviations). */
    submissionCount?: number;
    users?: string[];
    usersOverflowed?: boolean;
    histogram?: Record<string, number>;
    tenantId?: string;
    /** Emulate a pre-`submissionCount` row (total unknown). */
    legacy?: boolean;
  }): Promise<void> {
    const owner = options.tenantId ?? tenantId;
    const period = daysAgoPeriod(options.daysAgo ?? 0);
    const users = options.users ?? [];
    await counters.create({
      id: await fieldUsageCounterId(
        owner,
        objectRef,
        options.fieldName,
        period,
      ),
      objectRef,
      fieldName: options.fieldName,
      tenantId: owner,
      period,
      submissionCount: options.legacy
        ? 0
        : (options.submissionCount ?? options.setCount),
      setCount: options.setCount,
      distinctUserIds: JSON.stringify(users),
      distinctUserCount: users.length,
      distinctUsersOverflowed: options.usersOverflowed ?? false,
      ...(options.histogram
        ? { valueHistogram: JSON.stringify(options.histogram) }
        : {}),
    });
  }

  const users = (n: number) => Array.from({ length: n }, () => randomUUID());

  beforeEach(async () => {
    setupTestTenancy();
    clearFieldPolicyCache();
    db = await getTestDatabase({
      classes: [
        'FieldPolicy',
        'FieldPolicySuggestion',
        'FieldUsageCounter',
        'FieldUsageReportReceipt',
        'Tenant',
      ],
    });
    counters = await FieldUsageCounterCollection.create({ db });
    suggestions = await FieldPolicySuggestionCollection.create({ db });
    policies = await FieldPolicyCollection.create({ db });
    objectRef = fixtureRef();
    tenantId = randomUUID();
  });

  afterEach(async () => {
    clearFieldPolicyCache();
    resetTenancy();
    if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
      await (db as unknown as { close: () => Promise<void> }).close();
    }
  });

  describe('suggestion generation', () => {
    it('creates a promote suggestion with human-readable evidence once thresholds pass', async () => {
      await seedCounter({
        fieldName: 'region',
        daysAgo: 2,
        setCount: 9,
        users: users(3),
      });
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 8,
        users: users(2),
      });

      const summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.created).toBe(1);

      const rows = await suggestions.list({
        where: { tenantId, objectRef, fieldName: 'region', kind: 'promote' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');
      const evidence = rows[0].getEvidence();
      expect(evidence.summary).toMatch(
        /5 users set "region" to a non-default value in 17 of 17 submissions/,
      );
      expect(evidence.submissionCount).toBe(17);
      expect(evidence.distinctUsers).toBe(5);
      expect(evidence.setCount).toBe(17);
      expect(evidence.threshold).toBe(
        FIELD_USAGE_SUGGESTION_DEFAULTS.minDistinctUsers,
      );
    });

    it('stays quiet below thresholds, for already-basic fields, and outside the window', async () => {
      // Below the distinct-user threshold.
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 20,
        users: users(4),
      });
      // Already-basic field with plenty of usage.
      await seedCounter({
        fieldName: 'headline',
        daysAgo: 1,
        setCount: 50,
        users: users(20),
      });

      let summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.created).toBe(0);

      // Enough distinct users, but the buckets fell out of the window.
      await seedCounter({
        fieldName: 'region',
        daysAgo: 45,
        setCount: 30,
        users: users(30),
      });
      summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.created).toBe(0);
      expect(await suggestions.list({ where: { tenantId } })).toHaveLength(0);
    });

    it('treats an overflowed distinct-user set as an honest lower bound', async () => {
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 300,
        users: users(6),
        usersOverflowed: true,
      });
      const summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.created).toBe(1);
      const [row] = await suggestions.list({
        where: { tenantId, fieldName: 'region' },
      });
      expect(row.getEvidence().distinctUsersAtLeast).toBe(true);
      expect(row.getEvidence().summary).toMatch(/at least 6 users/);
    });

    it('creates a default suggestion from a value dominating TOTAL submissions', async () => {
      await seedCounter({
        fieldName: 'featured',
        daysAgo: 1,
        setCount: 12,
        submissionCount: 12,
        users: users(2),
        histogram: { true: 11, false: 1 },
      });

      const summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.created).toBe(1);

      const [row] = await suggestions.list({
        where: { tenantId, fieldName: 'featured', kind: 'default' },
      });
      expect(row.getProposedValue()).toBe(true);
      const evidence = row.getEvidence();
      expect(evidence.topValue).toBe(true);
      expect(evidence.topValueShare).toBeCloseTo(11 / 12, 4);
      expect(evidence.submissionCount).toBe(12);
      expect(evidence.setCount).toBe(12);
      expect(evidence.summary).toMatch(
        /92% of all 12 submissions used the value true/,
      );
    });

    it('does NOT propose a value that only dominates the DEVIATIONS (P1 regression)', async () => {
      // The reported scenario: a boolean defaulting to `false` collects 10
      // `true` deviations while ~1000 submissions keep the default. Counting
      // only deviations made `true` look 100% dominant; against TOTAL
      // submissions it is ~1%.
      await seedCounter({
        fieldName: 'optedIn',
        daysAgo: 1,
        setCount: 10,
        submissionCount: 1010,
        users: users(2),
        histogram: { true: 10, false: 1000 },
      });

      const summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.created).toBe(0);
      expect(
        await suggestions.list({ where: { tenantId, kind: 'default' } }),
      ).toHaveLength(0);

      // The SAME deviation count against a small total DOES dominate (another
      // tenant, so the windows do not merge) — proving the denominator alone
      // changed the verdict.
      const smallTotalTenant = randomUUID();
      await seedCounter({
        fieldName: 'optedIn',
        daysAgo: 1,
        setCount: 10,
        submissionCount: 11,
        users: users(2),
        histogram: { true: 10, false: 1 },
        tenantId: smallTotalTenant,
      });
      const second = await runFieldPolicySuggestionGeneration({ db });
      expect(second.created).toBe(1);
      expect(
        await suggestions.list({ where: { tenantId, kind: 'default' } }),
      ).toHaveLength(0);
      const [row] = await suggestions.list({
        where: {
          tenantId: smallTotalTenant,
          fieldName: 'optedIn',
          kind: 'default',
        },
      });
      expect(row.getProposedValue()).toBe(true);
      // Evidence states BOTH numbers: deviations and the total behind the %.
      expect(row.getEvidence().summary).toMatch(
        /10 of 11 submissions.*91% of all 11 submissions/,
      );
    });

    it('merges prototype-shaped text ids without corrupting counts (P2 regression)', async () => {
      // Split across two buckets so the MERGE path (not just storage) has to
      // accumulate `constructor` / `__proto__` / `toString` as plain data.
      const histogramA = Object.fromEntries([
        ['constructor', 6],
        ['__proto__', 1],
        ['toString', 1],
      ]);
      const histogramB = Object.fromEntries([
        ['constructor', 6],
        ['__proto__', 1],
      ]);
      await seedCounter({
        fieldName: 'externalOwner',
        daysAgo: 2,
        setCount: 8,
        submissionCount: 8,
        users: users(2),
        histogram: histogramA,
      });
      await seedCounter({
        fieldName: 'externalOwner',
        daysAgo: 1,
        setCount: 7,
        submissionCount: 7,
        users: users(2),
        histogram: histogramB,
      });

      const summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.groupsFailed).toBe(0);
      expect(summary.created).toBe(1);

      // 12 of 15 submissions used `constructor` (80% — exactly the threshold),
      // so it is proposed as the org default with an honest share.
      const [row] = await suggestions.list({
        where: { tenantId, fieldName: 'externalOwner', kind: 'default' },
      });
      expect(row.getProposedValue()).toBe('constructor');
      expect(row.getEvidence().topValue).toBe('constructor');
      expect(row.getEvidence().topValueShare).toBeCloseTo(12 / 15, 4);
    });

    it('skips default suggestions for legacy buckets with no recorded total', async () => {
      await seedCounter({
        fieldName: 'featured',
        daysAgo: 1,
        setCount: 40,
        users: users(6),
        histogram: { true: 40 },
        legacy: true,
      });

      const summary = await runFieldPolicySuggestionGeneration({ db });
      // Promote still fires (it needs no denominator); default is skipped, and
      // the evidence says the total was never recorded.
      expect(
        await suggestions.list({ where: { tenantId, kind: 'default' } }),
      ).toHaveLength(0);
      expect(summary.created).toBe(1);
      const [promote] = await suggestions.list({
        where: { tenantId, kind: 'promote' },
      });
      expect(promote.getEvidence().submissionCountUnknown).toBe(true);
      expect(promote.getEvidence().summary).toMatch(
        /40 of an unrecorded number of submissions/,
      );
    });

    it('skips default suggestions when dominance is weak or the default already matches', async () => {
      await seedCounter({
        fieldName: 'featured',
        daysAgo: 1,
        setCount: 12,
        submissionCount: 12,
        users: users(2),
        histogram: { true: 7, false: 5 },
      });
      let summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.created).toBe(0);

      // Dominant, but the org default already IS the dominant value.
      await withTenant(
        {
          tenantId,
          userId: randomUUID(),
          permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
        },
        async () => {
          await policies.create({
            objectRef,
            fieldName: 'featured',
            scopeType: 'tenant',
            tenantId,
            defaultValue: JSON.stringify(true),
          });
        },
      );
      await seedCounter({
        fieldName: 'featured',
        daysAgo: 2,
        setCount: 100,
        submissionCount: 100,
        users: users(2),
        histogram: { true: 100 },
      });
      summary = await runFieldPolicySuggestionGeneration({ db });
      expect(summary.created).toBe(0);
    });

    it('dedups against pending suggestions and honors the dismissal cool-down', async () => {
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 30,
        users: users(8),
      });

      expect((await runFieldPolicySuggestionGeneration({ db })).created).toBe(
        1,
      );
      // Pending suggestion suppresses regeneration.
      const second = await runFieldPolicySuggestionGeneration({ db });
      expect(second.created).toBe(0);
      expect(second.suppressed).toBeGreaterThanOrEqual(1);

      // Dismissed with a live cool-down: still suppressed.
      const [pending] = await suggestions.list({
        where: { tenantId, fieldName: 'region', status: 'pending' },
      });
      await withTenant(
        {
          tenantId,
          userId: randomUUID(),
          permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
        },
        () => suggestions.dismissSuggestion({ id: String(pending.id) }),
      );
      expect((await runFieldPolicySuggestionGeneration({ db })).created).toBe(
        0,
      );

      // Cool-down elapsed (raw clock rewind): regeneration resumes.
      await db.query(
        `UPDATE _smrt_field_policy_suggestions SET cooldown_until = ? WHERE id = ?`,
        new Date(Date.now() - 1000).toISOString(),
        String(pending.id),
      );
      expect((await runFieldPolicySuggestionGeneration({ db })).created).toBe(
        1,
      );
    });

    it('never lets one unprocessable group abort the run (P1 regression)', async () => {
      // A poisoned group: a reference histogram carrying an id the FieldPolicy
      // rail refuses (non-UUID for a UUID-backed column). Its `default`
      // candidate wins dominance and then fails suggestion validation — which
      // used to abort the whole cross-tenant pass, starving every later group
      // until the buckets expired.
      const poisonedTenant = '00000000-0000-4000-8000-000000000001';
      const healthyTenant = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      await seedCounter({
        fieldName: 'ownerRef',
        daysAgo: 1,
        setCount: 12,
        submissionCount: 12,
        users: users(2),
        histogram: { 'not-a-uuid': 12 },
        tenantId: poisonedTenant,
      });
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 30,
        users: users(8),
        tenantId: healthyTenant,
      });

      const summary = await runFieldPolicySuggestionGeneration({ db });

      // The bad group is reported, not thrown...
      expect(summary.groupsFailed).toBe(1);
      expect(summary.failures).toHaveLength(1);
      expect(summary.failures[0]).toContain('ownerRef');
      expect(summary.failures.length).toBeLessThanOrEqual(
        MAX_REPORTED_GROUP_FAILURES,
      );
      // ...and the healthy group still produced its suggestion.
      expect(summary.created).toBe(1);
      const healthy = await suggestions.list({
        where: { tenantId: healthyTenant, fieldName: 'region' },
      });
      expect(healthy).toHaveLength(1);
      expect(
        await suggestions.list({ where: { tenantId: poisonedTenant } }),
      ).toHaveLength(0);

      // A clean re-run reports no failures once the poisoned bucket is gone.
      await db.query(
        `DELETE FROM _smrt_field_usage_counters WHERE tenant_id = ?`,
        poisonedTenant,
      );
      const second = await runFieldPolicySuggestionGeneration({ db });
      expect(second.groupsFailed).toBe(0);
      expect(second.failures).toEqual([]);
    });

    it('keeps ONE active row when overlapping runs race the dedup (P2 regression)', async () => {
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 30,
        users: users(8),
      });

      // Two overlapping generation passes (the global + a tenant-specific
      // schedule) both observe "no pending row" before either inserts. The
      // active-slot unique index converges them, so no duplicate can exist —
      // the guarantee is structural, not a check-then-insert race.
      await Promise.all([
        runFieldPolicySuggestionGeneration({ db }),
        runFieldPolicySuggestionGeneration({ db }),
      ]);

      const pending = await suggestions.list({
        where: { tenantId, objectRef, fieldName: 'region', kind: 'promote' },
      });
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('pending');
      expect(pending[0].activeKey).toBe(ACTIVE_SUGGESTION_KEY);
    });

    it('frees the active slot on settle, keeping settled history addressable', async () => {
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 30,
        users: users(8),
      });
      await runFieldPolicySuggestionGeneration({ db });
      const [active] = await suggestions.list({
        where: { tenantId, fieldName: 'region', status: 'pending' },
      });

      await withTenant(
        {
          tenantId,
          userId: randomUUID(),
          permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
        },
        () => suggestions.dismissSuggestion({ id: String(active.id) }),
      );

      // Settled rows key themselves by id (id preserved — core conflicts a
      // persisted row on its PK), so the shared 'active' slot is free again.
      const settled = await suggestions.get(String(active.id));
      expect(settled?.status).toBe('dismissed');
      expect(settled?.activeKey).toBe(String(active.id));

      // Cool-down elapsed ⇒ a new active row may be written alongside the
      // settled one, and both survive.
      await db.query(
        `UPDATE _smrt_field_policy_suggestions SET cooldown_until = ? WHERE id = ?`,
        new Date(Date.now() - 1000).toISOString(),
        String(active.id),
      );
      await runFieldPolicySuggestionGeneration({ db });
      const all = await suggestions.list({
        where: { tenantId, fieldName: 'region', kind: 'promote' },
      });
      expect(all).toHaveLength(2);
      expect(all.filter((row) => row.status === 'pending')).toHaveLength(1);
      expect(all.filter((row) => row.status === 'dismissed')).toHaveLength(1);
    });

    it('restricts an ambient-context run to the ambient tenant', async () => {
      const otherTenant = randomUUID();
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 30,
        users: users(8),
      });
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 30,
        users: users(8),
        tenantId: otherTenant,
      });

      await withTenant(
        { tenantId, userId: randomUUID(), permissions: new Set<string>() },
        async () => {
          const summary = await runFieldPolicySuggestionGeneration({ db });
          expect(summary.created).toBe(1);
        },
      );
      expect(
        await suggestions.list({ where: { tenantId, status: 'pending' } }),
      ).toHaveLength(1);
      expect(
        await suggestions.list({
          where: { tenantId: otherTenant, status: 'pending' },
        }),
      ).toHaveLength(0);
    });

    it('accepting a generated suggestion shifts the resolver for the org (end to end)', async () => {
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 30,
        users: users(8),
      });
      await runFieldPolicySuggestionGeneration({ db });

      const before = await resolveFieldPolicy(objectRef, { tenantId, db });
      expect(before.fields.region.visibility).toBe('advanced');

      const managerId = randomUUID();
      await withTenant(
        {
          tenantId,
          userId: managerId,
          permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
        },
        async () => {
          const { suggestions: pending } =
            await suggestions.pendingSuggestions();
          expect(pending).toHaveLength(1);
          await suggestions.acceptSuggestion({ id: pending[0].id });
        },
      );

      const after = await resolveFieldPolicy(objectRef, { tenantId, db });
      expect(after.fields.region.visibility).toBe('basic');
    });
  });

  describe('retention', () => {
    it('prunes counter rows by age (period cutoff), oldest first', async () => {
      await seedCounter({ fieldName: 'region', daysAgo: 40, setCount: 1 });
      await seedCounter({ fieldName: 'region', daysAgo: 10, setCount: 1 });
      await seedCounter({ fieldName: 'region', daysAgo: 0, setCount: 1 });

      const result = await pruneFieldUsageCounters(db, {
        maxAgeMs: 30 * DAY_MS,
      });
      expect(result.pruned).toBe(1);
      const remaining = await counters.list({ orderBy: 'period ASC' });
      expect(remaining.map((row) => row.period)).toEqual([
        daysAgoPeriod(10),
        daysAgoPeriod(0),
      ]);
    });

    it('prunes counter rows over maxRows, keeping the newest buckets', async () => {
      for (const daysAgo of [5, 4, 3, 2, 1]) {
        await seedCounter({ fieldName: 'region', daysAgo, setCount: 1 });
      }
      const result = await pruneFieldUsageCounters(db, { maxRows: 2 });
      expect(result.pruned).toBe(3);
      const remaining = await counters.list({ orderBy: 'period ASC' });
      expect(remaining.map((row) => row.period)).toEqual([
        daysAgoPeriod(2),
        daysAgoPeriod(1),
      ]);
    });

    it('prunes daily receipts at the counter age cutoff without reopening active de-duplication', async () => {
      await withTenant(
        { tenantId, userId: randomUUID(), permissions: new Set() },
        () =>
          counters.reportUsage({
            entries: [
              { objectRef, fieldName: 'region' },
              { objectRef, fieldName: 'headline' },
            ],
          }),
      );

      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120 * DAY_MS);
      try {
        const countersPruned = await pruneFieldUsageCounters(db, {
          maxAgeMs: 90 * DAY_MS,
        });
        const receiptsPruned = await pruneFieldUsageReportReceipts(db, {
          maxAgeMs: 90 * DAY_MS,
        });
        expect(countersPruned.pruned).toBe(2);
        expect(receiptsPruned.pruned).toBe(2);
      } finally {
        clock.mockRestore();
      }
    });

    it('honors an EXPLICIT zero bound instead of the default (P2 regression)', async () => {
      // `0` is a value the prune functions accept and it means "purge
      // everything"; swapping it for the 90d/100k default silently ignores an
      // operator's explicit instruction.
      for (const daysAgo of [5, 1, 0]) {
        await seedCounter({ fieldName: 'region', daysAgo, setCount: 1 });
      }
      await suggestions.create({
        tenantId,
        objectRef,
        fieldName: 'headline',
        kind: 'promote',
        evidence: '{}',
        status: 'accepted',
        decidedAt: new Date(),
      });

      const purged = await runFieldUsageMaintenance({
        db,
        counterMaxRows: 0,
        counterMaxAgeMs: 0,
        suggestionAcceptedMaxAgeMs: 0,
      });
      expect(purged.countersPruned).toBeGreaterThanOrEqual(3);
      expect(await counters.list({})).toHaveLength(0);
      // An accepted suggestion of age >= 0 is settled history, so it goes too.
      expect(purged.suggestionsPruned).toBe(1);

      // `undefined` still takes the documented default: nothing this fresh is
      // pruned by the 90d / 100k / 180d bounds.
      for (const daysAgo of [5, 1, 0]) {
        await seedCounter({ fieldName: 'region', daysAgo, setCount: 1 });
      }
      await suggestions.create({
        tenantId,
        objectRef,
        fieldName: 'headline',
        kind: 'promote',
        evidence: '{}',
        status: 'accepted',
        decidedAt: new Date(),
      });
      const defaulted = await runFieldUsageMaintenance({ db });
      expect(defaulted.countersPruned).toBe(0);
      expect(defaulted.suggestionsPruned).toBe(0);
      expect(await counters.list({})).toHaveLength(3);
    });

    it('requires at least one bound (pruneChangeFeed parity)', async () => {
      await expect(pruneFieldUsageCounters(db, {})).rejects.toThrow(
        /maxAgeMs and\/or maxRows/,
      );
    });

    it('prunes ONLY settled suggestions: dismissed past cool-down or accepted old', async () => {
      const mkSuggestion = async (
        fieldName: string,
        status: 'pending' | 'accepted' | 'dismissed',
        options: { cooldownUntil?: Date; decidedAt?: Date } = {},
      ) =>
        suggestions.create({
          tenantId,
          objectRef,
          fieldName,
          kind: 'promote',
          evidence: '{}',
          status,
          ...(options.cooldownUntil
            ? { cooldownUntil: options.cooldownUntil }
            : {}),
          ...(options.decidedAt ? { decidedAt: options.decidedAt } : {}),
        });

      const now = new Date();
      await mkSuggestion('region', 'pending');
      await mkSuggestion('headline', 'dismissed', {
        cooldownUntil: new Date(now.getTime() - 1000), // past cool-down
        decidedAt: new Date(now.getTime() - 1000),
      });
      await mkSuggestion('featured', 'dismissed', {
        cooldownUntil: new Date(now.getTime() + DAY_MS), // still cooling down
        decidedAt: now,
      });

      const acceptedOld = await mkSuggestion('region', 'accepted', {
        decidedAt: new Date(now.getTime() - 200 * DAY_MS),
      });
      const acceptedRecent = await mkSuggestion('headline', 'accepted', {
        decidedAt: now,
      });

      const result = await pruneFieldPolicySuggestions(db, {
        acceptedMaxAgeMs: 180 * DAY_MS,
        now,
      });
      expect(result.pruned).toBe(2);

      const remaining = await suggestions.list({ where: { tenantId } });
      const keys = remaining.map((row) => `${row.fieldName}:${row.status}`);
      expect(keys).toContain('region:pending');
      expect(keys).toContain('featured:dismissed');
      expect(keys).toContain('headline:accepted');
      expect(remaining.map((row) => String(row.id))).not.toContain(
        String(acceptedOld.id),
      );
      expect(remaining.map((row) => String(row.id))).toContain(
        String(acceptedRecent.id),
      );
    });

    it('runFieldUsageMaintenance combines both prunes and reports the tally', async () => {
      await seedCounter({ fieldName: 'region', daysAgo: 120, setCount: 1 });
      await seedCounter({ fieldName: 'region', daysAgo: 0, setCount: 1 });
      await suggestions.create({
        tenantId,
        objectRef,
        fieldName: 'headline',
        kind: 'promote',
        evidence: '{}',
        status: 'dismissed',
        cooldownUntil: new Date(Date.now() - 1000),
        decidedAt: new Date(Date.now() - 1000),
      });

      const summary = await runFieldUsageMaintenance({ db });
      expect(summary.countersPruned).toBe(1);
      expect(summary.receiptsPruned).toBe(0);
      expect(summary.suggestionsPruned).toBe(1);
      expect(await counters.list({})).toHaveLength(1);
    });
  });

  describe('schedule target + installer', () => {
    it('registers the agent type the schedules name, with a closed background allowlist', () => {
      const registered = ObjectRegistry.getClassByConstructor(
        FieldUsageLearningAgent,
      );
      expect(registered?.qualifiedName).toBe(FIELD_USAGE_LEARNING_AGENT_TYPE);
      expect([...FieldUsageLearningAgent.backgroundEligibleMethods]).toEqual([
        FIELD_USAGE_MAINTENANCE_METHOD,
        FIELD_USAGE_SUGGESTION_METHOD,
      ]);
    });

    it('runs the schedule methods with methodArgs payload overrides', async () => {
      await seedCounter({
        fieldName: 'region',
        daysAgo: 1,
        setCount: 3,
        users: users(2),
      });
      await seedCounter({ fieldName: 'region', daysAgo: 4, setCount: 1 });
      // The jobs runner constructs the registered class and initializes it
      // before invoking the scheduled method — mirror that here.
      const agent = new FieldUsageLearningAgent({ db });
      await agent.initialize();
      // Threshold lowered through the schedule payload: 2 users suffice.
      const summary = await agent.runSuggestionGeneration({
        minDistinctUsers: 2,
        junk: 'ignored',
      });
      expect(summary.created).toBe(1);

      // Age pruning is day-granular (`period < day(now - maxAgeMs)`), so the
      // 4-day-old bucket falls, the 1-day-old bucket survives.
      const maintenance = await agent.runUsageMaintenance({
        counterMaxAgeMs: 2 * DAY_MS,
      });
      expect(maintenance.countersPruned).toBe(1);
    });

    it('installs DORMANT global schedules idempotently through the agents seam', async () => {
      const created: Array<Record<string, unknown>> = [];
      const fakeAgents: FieldUsageAgentsModule = {
        AgentScheduleCollection: {
          create: async () => ({
            list: async (options: { where: Record<string, unknown> }) =>
              created.filter((row) =>
                options.where.id !== undefined
                  ? row.id === options.where.id
                  : row.method === options.where.method,
              ) as Array<{ id?: string }>,
            create: async (data: Record<string, unknown>) => {
              // Model the real strict-insert contract: a caller-supplied id
              // that already exists raises instead of adopting the row.
              if (
                data._insertOnly === true &&
                created.some((row) => row.id === data.id)
              ) {
                throw new Error(`UNIQUE constraint failed: id ${data.id}`);
              }
              const row = { ...data, saved: false };
              created.push(row);
              return {
                ...row,
                save: async () => {
                  row.saved = true;
                  return row;
                },
              };
            },
          }),
        },
      };

      const first = await ensureFieldUsageLearningSchedules({
        db,
        agentsModule: fakeAgents,
      });
      expect(first).toEqual({ installed: true, created: 2 });
      expect(created).toHaveLength(2);
      for (const row of created) {
        expect(row.agentType).toBe(FIELD_USAGE_LEARNING_AGENT_TYPE);
        expect(row.tenantId).toBeNull();
        expect(row.enabled).toBe(false); // DORMANT by default
        expect(row.status).toBe('disabled');
        expect(row.saved).toBe(true);
      }
      expect(created.map((row) => row.method)).toEqual([
        FIELD_USAGE_MAINTENANCE_METHOD,
        FIELD_USAGE_SUGGESTION_METHOD,
      ]);
      expect(created.map((row) => row.cron)).toEqual([
        DEFAULT_FIELD_USAGE_MAINTENANCE_CRON,
        DEFAULT_FIELD_USAGE_SUGGESTION_CRON,
      ]);

      // Ids are DETERMINISTIC (that is what makes concurrent installs converge)
      // and the installer never advertises a timezone it cannot honor.
      expect(created.map((row) => row.id)).toEqual([
        await fieldUsageScheduleId(FIELD_USAGE_MAINTENANCE_METHOD),
        await fieldUsageScheduleId(FIELD_USAGE_SUGGESTION_METHOD),
      ]);
      for (const row of created) {
        expect(row.timezone).toBeUndefined();
        expect(row._insertOnly).toBe(true);
      }

      // Idempotent: existing rows are never touched or duplicated.
      const second = await ensureFieldUsageLearningSchedules({
        db,
        agentsModule: fakeAgents,
      });
      expect(second).toEqual({ installed: true, created: 0 });
      expect(created).toHaveLength(2);
    });

    it('yields exactly one row per schedule under concurrent installs (P2 regression)', async () => {
      // Two replicas starting against an EMPTY database: both pre-checks see
      // nothing, so only the deterministic id + strict insert can prevent
      // duplicate schedules (which, when enabled, would run every job twice).
      const rows: Array<Record<string, unknown>> = [];
      let releaseChecks: () => void = () => {};
      const bothChecked = new Promise<void>((resolve) => {
        let seen = 0;
        releaseChecks = () => {
          seen += 1;
          if (seen >= 2) resolve();
        };
      });

      const fakeAgents: FieldUsageAgentsModule = {
        AgentScheduleCollection: {
          create: async () => ({
            list: async (options: { where: Record<string, unknown> }) => {
              // The installer re-reads by id after a failed insert to confirm
              // a genuine collision; that lookup must not be interleaved.
              if (options.where.id !== undefined) {
                return rows.filter(
                  (row) => row.id === options.where.id,
                ) as Array<{ id?: string; tenantId?: string | null }>;
              }
              const matches = rows.filter(
                (row) => row.method === options.where.method,
              ) as Array<{ id?: string; tenantId?: string | null }>;
              // Force the interleaving: both installers finish their existence
              // check before either inserts.
              releaseChecks();
              await bothChecked;
              return matches;
            },
            create: async (data: Record<string, unknown>) => {
              if (rows.some((row) => row.id === data.id)) {
                throw new Error(`UNIQUE constraint failed: id ${data.id}`);
              }
              rows.push({ ...data });
              return { ...data, save: async () => data };
            },
          }),
        },
      };

      const [a, b] = await Promise.all([
        ensureFieldUsageLearningSchedules({ db, agentsModule: fakeAgents }),
        ensureFieldUsageLearningSchedules({ db, agentsModule: fakeAgents }),
      ]);

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.method)).size).toBe(2);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
      // Between them exactly two rows were created; the loser reports 0 for
      // whichever schedules it lost.
      expect(a.created + b.created).toBe(2);
      expect(a.installed && b.installed).toBe(true);
    });

    it('still installs the GLOBAL rows when tenant-scoped ones exist (P2 regression)', async () => {
      // A deployment may run tenant-specific schedules for the same agent type
      // and method. An unscoped existence check would match those and silently
      // skip the global schedules this installer promises.
      const rows: Array<Record<string, unknown>> = [
        {
          id: randomUUID(),
          tenantId: randomUUID(),
          agentType: FIELD_USAGE_LEARNING_AGENT_TYPE,
          method: FIELD_USAGE_MAINTENANCE_METHOD,
        },
        {
          id: randomUUID(),
          tenantId: randomUUID(),
          agentType: FIELD_USAGE_LEARNING_AGENT_TYPE,
          method: FIELD_USAGE_SUGGESTION_METHOD,
        },
      ];
      const fakeAgents: FieldUsageAgentsModule = {
        AgentScheduleCollection: {
          create: async () => ({
            list: async (options: { where: Record<string, unknown> }) =>
              rows.filter(
                (row) => row.method === options.where.method,
              ) as Array<{
                id?: string;
                tenantId?: string | null;
              }>,
            create: async (data: Record<string, unknown>) => {
              const row = { ...data, id: randomUUID() };
              rows.push(row);
              return { ...row, save: async () => row };
            },
          }),
        },
      };

      const result = await ensureFieldUsageLearningSchedules({
        db,
        agentsModule: fakeAgents,
      });
      expect(result).toEqual({ installed: true, created: 2 });
      const globals = rows.filter(
        (row) => row.tenantId === null || row.tenantId === undefined,
      );
      expect(globals).toHaveLength(2);
      expect(globals.map((row) => row.method)).toEqual([
        FIELD_USAGE_MAINTENANCE_METHOD,
        FIELD_USAGE_SUGGESTION_METHOD,
      ]);
      // The pre-existing tenant rows were left untouched.
      expect(
        rows.filter((row) => typeof row.tenantId === 'string'),
      ).toHaveLength(2);

      // And a second pass now finds the globals and creates nothing.
      const again = await ensureFieldUsageLearningSchedules({
        db,
        agentsModule: fakeAgents,
      });
      expect(again).toEqual({ installed: true, created: 0 });
    });

    it('propagates non-collision install failures instead of faking success (P2 regression)', async () => {
      // A transient DB/schema/validation error must NOT be read as "another
      // installer won the deterministic-id race": that would report
      // installed:true with the schedule missing.
      const brokenAgents: FieldUsageAgentsModule = {
        AgentScheduleCollection: {
          create: async () => ({
            list: async (options: { where: Record<string, unknown> }) => {
              // Nothing exists — neither the pre-check nor the collision
              // re-read finds a row, so the failure cannot be a collision.
              void options;
              return [];
            },
            create: async () => {
              throw new Error('no such column: method_args');
            },
          }),
        },
      };
      await expect(
        ensureFieldUsageLearningSchedules({ db, agentsModule: brokenAgents }),
      ).rejects.toThrow(/no such column/);

      // A GENUINE collision (the row is there on re-read) still reports
      // installed:true and creates nothing.
      const existingRows: Array<Record<string, unknown>> = [];
      const collidingAgents: FieldUsageAgentsModule = {
        AgentScheduleCollection: {
          create: async () => ({
            list: async (options: { where: Record<string, unknown> }) =>
              options.where.id === undefined
                ? [] // pre-check sees nothing (the racing replica is mid-insert)
                : (existingRows.filter(
                    (row) => row.id === options.where.id,
                  ) as Array<{ id?: string; tenantId?: string | null }>),
            create: async (data: Record<string, unknown>) => {
              // Simulate the racing replica landing its row first.
              existingRows.push({ ...data });
              throw new Error('UNIQUE constraint failed: id');
            },
          }),
        },
      };
      const result = await ensureFieldUsageLearningSchedules({
        db,
        agentsModule: collidingAgents,
      });
      expect(result).toEqual({ installed: true, created: 0 });
    });

    it('opt-in activation and per-schedule threshold payloads are honored', async () => {
      const created: Array<Record<string, unknown>> = [];
      const fakeAgents: FieldUsageAgentsModule = {
        AgentScheduleCollection: {
          create: async () => ({
            list: async () => [],
            create: async (data: Record<string, unknown>) => {
              created.push(data);
              return { ...data, save: async () => data };
            },
          }),
        },
      };

      await ensureFieldUsageLearningSchedules({
        db,
        agentsModule: fakeAgents,
        enabled: true,
        suggestionArgs: { minDistinctUsers: 3 },
      });
      expect(created[0].enabled).toBe(true);
      expect(created[0].status).toBe('active');
      expect(created[1].methodArgs).toEqual({ minDistinctUsers: 3 });
    });

    it('refuses installation from a non-bypass tenant context (global state)', async () => {
      await expect(
        withTenant(
          { tenantId, userId: randomUUID(), permissions: new Set<string>() },
          () =>
            ensureFieldUsageLearningSchedules({
              db,
              agentsModule: {
                AgentScheduleCollection: {
                  create: async () => ({
                    list: async () => [],
                    create: async (data: Record<string, unknown>) => data,
                  }),
                },
              },
            }),
        ),
      ).rejects.toThrow(TenantIsolationError);
    });

    it('detects a missing agents package vs an installed-but-broken one', () => {
      const missing = new Error(
        "Cannot find package '@happyvertical/smrt-agents' imported from x",
      );
      expect(
        isMissingWorkspaceDependency(missing, '@happyvertical/smrt-agents'),
      ).toBe(true);

      const wrapped = new Error(
        'Failed to load @happyvertical/smrt-agents for field usage learning schedule installation: could not find source.',
      );
      expect(
        isMissingWorkspaceDependency(wrapped, '@happyvertical/smrt-agents'),
      ).toBe(true);

      // A transitive failure INSIDE an installed agents package rethrows.
      const transitive = new Error('boom');
      transitive.cause = new Error(
        "Cannot find package '@happyvertical/ai' imported from packages/agents/src/agent.ts",
      );
      expect(
        isMissingWorkspaceDependency(transitive, '@happyvertical/smrt-agents'),
      ).toBe(false);
    });
  });
});

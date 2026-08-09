/**
 * #2051 suggestion surface: the manage-gated `pendingSuggestions` /
 * `acceptSuggestion` / `dismissSuggestion` actions, tenant isolation on
 * suggestion rows, and acceptance flowing through FieldPolicy's NORMAL
 * validation (the resolver output shift is the end-to-end proof).
 */

import { randomUUID } from 'node:crypto';
import {
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
// Side-effect import: registers smrt-users' classes (Tenant) so the resolver's
// default hierarchy loader can walk the tenants table.
import '../../users/src/index.js';
import { clearFieldPolicyCache } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
import {
  DEFAULT_SUGGESTION_COOL_DOWN_MS,
  FieldPolicySuggestionCollection,
  FieldPolicySuggestionConflictError,
} from './collections/FieldPolicySuggestionCollection.js';
import { resolveFieldPolicy } from './field-policy-resolver.js';
import {
  ACTIVE_SUGGESTION_KEY,
  FieldPolicySuggestion,
} from './models/FieldPolicySuggestion.js';
import { MANAGE_FIELD_POLICY_PERMISSION } from './permissions.js';
import type { AcceptFieldPolicySuggestionResult } from './types.js';
import { runFieldPolicySuggestionGeneration } from './usage-learning.js';

@smrt({
  packageName: '@test/smrt-fields-suggestions',
  visibility: 'internal',
  api: false,
  cli: false,
  mcp: false,
})
class SuggestionDoc extends SmrtObject {
  @field({ ui: { basic: true } })
  headline: string = '';

  // Unmarked while headline is basic ⇒ resolves 'advanced' (cold-start rule):
  // the promote-suggestion target.
  @field()
  region: string = '';

  @field({ type: 'boolean' })
  featured: boolean = false;

  @field({ sensitive: true })
  apiToken: string = '';
}

function fixtureRef(): string {
  const registered = ObjectRegistry.getClassByConstructor(SuggestionDoc);
  if (!registered?.qualifiedName) {
    throw new Error('SuggestionDoc is not registered with a qualified name');
  }
  return registered.qualifiedName;
}

/**
 * A database handle WITHOUT `beginTransaction` — the shape a transaction view
 * presents (it exposes `transaction` only), which is what drives the
 * two-step claim path.
 */
function nonTransactionalView(db: DatabaseInterface): DatabaseInterface {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'beginTransaction') {
        return undefined;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, property) {
      return property === 'beginTransaction'
        ? false
        : Reflect.has(target, property);
    },
  });
}

describe('FieldPolicySuggestion actions (#2051)', () => {
  let db: DatabaseInterface;
  let suggestions: FieldPolicySuggestionCollection;
  let policies: FieldPolicyCollection;
  let objectRef: string;
  let tenantId: string;
  let userId: string;

  const asManager = <T>(fn: () => Promise<T>): Promise<T> =>
    withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      fn,
    );

  const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
    withTenant({ tenantId, userId, permissions: new Set<string>() }, fn);

  /** Trusted-execution creation (no ambient context) — the generation job's path. */
  const seedSuggestion = (
    overrides: Partial<{
      tenantId: string;
      fieldName: string;
      kind: 'promote' | 'default';
      proposedValue: string | null;
    }> = {},
  ) =>
    suggestions.create({
      tenantId: overrides.tenantId ?? tenantId,
      objectRef,
      fieldName: overrides.fieldName ?? 'region',
      kind: overrides.kind ?? 'promote',
      proposedValue: overrides.proposedValue ?? null,
      evidence: JSON.stringify({ summary: 'seeded for test' }),
      status: 'pending',
    });

  beforeEach(async () => {
    setupTestTenancy();
    clearFieldPolicyCache();
    db = await getTestDatabase({
      // `FieldUsageCounter` backs the generation pass the non-transactional
      // interleaving test runs mid-decision.
      classes: [
        'FieldPolicy',
        'FieldPolicySuggestion',
        'FieldUsageCounter',
        'Tenant',
      ],
    });
    suggestions = await FieldPolicySuggestionCollection.create({ db });
    policies = await FieldPolicyCollection.create({ db });
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

  it('gates all three actions on ambient context + fields.policy.manage', async () => {
    await expect(suggestions.pendingSuggestions()).rejects.toThrow(
      TenantIsolationError,
    );
    await expect(
      asMember(() => suggestions.pendingSuggestions()),
    ).rejects.toThrow(/Permission denied/);
    await expect(
      asMember(() => suggestions.acceptSuggestion({ id: randomUUID() })),
    ).rejects.toThrow(/Permission denied/);
    await expect(
      asMember(() => suggestions.dismissSuggestion({ id: randomUUID() })),
    ).rejects.toThrow(/Permission denied/);
  });

  it('lists only the ambient tenant’s pending suggestions', async () => {
    await seedSuggestion();
    await seedSuggestion({ tenantId: randomUUID(), fieldName: 'headline' });

    const result = await asManager(() => suggestions.pendingSuggestions());
    expect(result.total).toBe(1);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].tenantId).toBe(tenantId);
    expect(result.suggestions[0].fieldName).toBe('region');
    expect(result.suggestions[0].evidence.summary).toBe('seeded for test');

    // The objectRefs filter is validated and applied.
    const filtered = await asManager(() =>
      suggestions.pendingSuggestions({ objectRefs: ['@test/nowhere:Nope'] }),
    );
    expect(filtered.total).toBe(0);
    await expect(
      asManager(() => suggestions.pendingSuggestions({ objectRefs: [] })),
    ).rejects.toThrow(/non-empty string array/);
  });

  it('accepting a promote suggestion writes the org row and SHIFTS resolver output', async () => {
    const seeded = await seedSuggestion();

    const before = await resolveFieldPolicy(objectRef, { tenantId, db });
    expect(before.fields.region.visibility).toBe('advanced');

    const result = await asManager(() =>
      suggestions.acceptSuggestion({ id: String(seeded.id) }),
    );
    expect(result.suggestion.status).toBe('accepted');
    expect(result.suggestion.decidedBy).toBe(userId);

    const rows = await policies.list({
      where: { objectRef, fieldName: 'region', scopeType: 'tenant', tenantId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].visibility).toBe('basic');
    expect(String(rows[0].id)).toBe(result.policyRowId);

    // The org's forms change: the resolver now reports the field as basic.
    const after = await resolveFieldPolicy(objectRef, { tenantId, db });
    expect(after.fields.region.visibility).toBe('basic');
  });

  it('accepting a default suggestion UPDATES an existing tenant row in place', async () => {
    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'featured',
          scopeType: 'tenant',
          tenantId,
          help: 'kept through acceptance',
        });
      },
    );

    const seeded = await seedSuggestion({
      fieldName: 'featured',
      kind: 'default',
      proposedValue: JSON.stringify(true),
    });
    const result = await asManager(() =>
      suggestions.acceptSuggestion({ id: String(seeded.id) }),
    );

    const rows = await policies.list({
      where: {
        objectRef,
        fieldName: 'featured',
        scopeType: 'tenant',
        tenantId,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].getDefaultValue()).toBe(true);
    expect(rows[0].help).toBe('kept through acceptance');
    expect(String(rows[0].id)).toBe(result.policyRowId);

    const resolved = await resolveFieldPolicy(objectRef, { tenantId, db });
    expect(resolved.fields.featured.defaultValue).toBe(true);
  });

  it('acceptance runs FieldPolicy’s NORMAL validation (corrupt payloads are rejected)', async () => {
    const seeded = await seedSuggestion({
      fieldName: 'featured',
      kind: 'default',
      proposedValue: JSON.stringify(true),
    });
    // Corrupt the stored payload underneath the model (registry drift stand-in)
    // — acceptance must fail in FieldPolicy validation, not write a junk row.
    await db.query(
      `UPDATE _smrt_field_policy_suggestions SET proposed_value = ? WHERE id = ?`,
      '{not json',
      String(seeded.id),
    );

    await expect(
      asManager(() => suggestions.acceptSuggestion({ id: String(seeded.id) })),
    ).rejects.toThrow(/not valid JSON/);

    const rows = await policies.list({
      where: {
        objectRef,
        fieldName: 'featured',
        scopeType: 'tenant',
        tenantId,
      },
    });
    expect(rows).toHaveLength(0);
    // The suggestion stays pending — nothing was half-applied.
    const pending = await asManager(() => suggestions.pendingSuggestions());
    expect(pending.total).toBe(1);
  });

  it('dismissing sets status + cool-down and leaves the queue', async () => {
    const seeded = await seedSuggestion();
    const before = Date.now();
    const result = await asManager(() =>
      suggestions.dismissSuggestion({ id: String(seeded.id) }),
    );
    expect(result.suggestion.status).toBe('dismissed');
    expect(result.suggestion.decidedBy).toBe(userId);
    const cooldown = Date.parse(result.suggestion.cooldownUntil ?? '');
    expect(cooldown).toBeGreaterThanOrEqual(
      before + DEFAULT_SUGGESTION_COOL_DOWN_MS - 1000,
    );

    const pending = await asManager(() => suggestions.pendingSuggestions());
    expect(pending.total).toBe(0);

    // A settled suggestion cannot be decided again — and it raises the SAME
    // conflict type the compare-and-set does (see the ordering test below).
    await expect(
      asManager(() => suggestions.acceptSuggestion({ id: String(seeded.id) })),
    ).rejects.toThrow(FieldPolicySuggestionConflictError);
  });

  it('raises ONE conflict type for both settle-then-decide orderings (P2 regression)', async () => {
    // Ordering A: the competing decision lands BEFORE this request loads the
    // row, so the load sees a settled row.
    const settledFirst = await seedSuggestion();
    await asManager(() =>
      suggestions.dismissSuggestion({ id: String(settledFirst.id) }),
    );
    const loadPathError = await asManager(() =>
      suggestions
        .acceptSuggestion({ id: String(settledFirst.id) })
        .then(() => null)
        .catch((error: unknown) => error),
    );

    // Ordering B: it lands AFTER the load, so only the compare-and-set can
    // detect it. Loading and settling interleave via the racing pair.
    const racedRow = await seedSuggestion({ fieldName: 'featured' });
    const outcomes = await Promise.allSettled([
      asManager(() =>
        suggestions.acceptSuggestion({ id: String(racedRow.id) }),
      ),
      asManager(() =>
        suggestions.dismissSuggestion({ id: String(racedRow.id) }),
      ),
    ]);
    // Either decision may win the race; take whichever one lost.
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const claimPathError = (rejected[0] as PromiseRejectedResult).reason;

    // Purely-by-timing differences must not change the caller's contract.
    expect(loadPathError).toBeInstanceOf(FieldPolicySuggestionConflictError);
    expect(claimPathError).toBeInstanceOf(FieldPolicySuggestionConflictError);
    for (const error of [loadPathError, claimPathError]) {
      // `httpStatus` is core's generated-REST contract (own integer property);
      // `status` mirrors this package's FieldPolicyPermissionError shape.
      expect(Object.hasOwn(error as object, 'httpStatus')).toBe(true);
      expect((error as { httpStatus: number }).httpStatus).toBe(409);
      expect((error as { status: number }).status).toBe(409);
      expect((error as Error).name).toBe('FieldPolicySuggestionConflictError');
    }
  });

  it('rejects foreign-tenant decisions and in-context foreign writes', async () => {
    const foreignTenant = randomUUID();
    const foreign = await seedSuggestion({ tenantId: foreignTenant });

    await expect(
      asManager(() => suggestions.acceptSuggestion({ id: String(foreign.id) })),
    ).rejects.toThrow(TenantIsolationError);
    await expect(
      asManager(() =>
        suggestions.dismissSuggestion({ id: String(foreign.id) }),
      ),
    ).rejects.toThrow(TenantIsolationError);

    // Direct model writes from a foreign context hit the same boundary.
    await expect(
      asManager(async () => {
        const row = new FieldPolicySuggestion({
          db,
          tenantId: foreignTenant,
          objectRef,
          fieldName: 'region',
          kind: 'promote',
          evidence: '{}',
          status: 'pending',
        });
        await row.save();
      }),
    ).rejects.toThrow(TenantIsolationError);

    // An in-tenant principal MAY create a suggestion through normal
    // validation — the #1885 learning-agent seam.
    await asMember(async () => {
      await suggestions.create({
        tenantId,
        objectRef,
        fieldName: 'headline',
        kind: 'promote',
        evidence: JSON.stringify({ summary: 'proposed by a learning agent' }),
        status: 'pending',
      });
    });
    const pending = await asManager(() => suggestions.pendingSuggestions());
    expect(pending.suggestions.some((s) => s.fieldName === 'headline')).toBe(
      true,
    );
  });

  it('lets exactly one of a racing accept+dismiss pair win (P2 regression)', async () => {
    const seeded = await seedSuggestion();
    const id = String(seeded.id);

    const outcomes = await Promise.allSettled([
      asManager(() => suggestions.acceptSuggestion({ id })),
      asManager(() => suggestions.dismissSuggestion({ id })),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser reports a clear 409 conflict, not a generic failure.
    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(FieldPolicySuggestionConflictError);
    expect((error as { status: number }).status).toBe(409);
    expect((error as Error).message).toMatch(/no longer pending/);

    // Final state is internally consistent: the policy row exists IFF the
    // winner was the accept.
    const settled = await suggestions.get(id);
    const policyRows = await policies.list({
      where: { objectRef, fieldName: 'region', scopeType: 'tenant', tenantId },
    });
    if (settled?.status === 'accepted') {
      expect(policyRows).toHaveLength(1);
      expect(policyRows[0].visibility).toBe('basic');
      expect(settled.cooldownUntil).toBeNull();
    } else {
      expect(settled?.status).toBe('dismissed');
      expect(policyRows).toHaveLength(0);
      expect(settled?.cooldownUntil).not.toBeNull();
    }
  });

  it('keeps BOTH columns when promote+default are accepted concurrently (P1 regression)', async () => {
    // The two suggestions own DIFFERENT columns of the SAME sparse policy row.
    // A read-modify-save of the whole row loses one of them: each acceptance
    // reads before the other's write lands, and the later save erases the
    // sibling's column (and can replace the row id, dangling a policyRowId).
    const promote = await seedSuggestion({ fieldName: 'featured' });
    const setDefault = await seedSuggestion({
      fieldName: 'featured',
      kind: 'default',
      proposedValue: JSON.stringify(true),
    });

    // Drive the NON-TRANSACTIONAL path: sqlite's pool runs one transaction at
    // a time, so the tx path already serializes these two acceptances on this
    // driver — the exposure is the tx-less path (a transaction VIEW) and, on
    // PostgreSQL, READ COMMITTED, where two transactions interleave freely.
    const nonTxSuggestions = await FieldPolicySuggestionCollection.create({
      db: nonTransactionalView(db),
    });

    // Force the interleaving: hold both acceptances until each has finished
    // looking for an existing row, so neither can serialize behind the other.
    const originalCreate = FieldPolicyCollection.create;
    let arrived = 0;
    let releaseBoth: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = () => {
        arrived += 1;
        if (arrived >= 2) resolve();
      };
    });
    let results: AcceptFieldPolicySuggestionResult[];
    try {
      (FieldPolicyCollection as unknown as { create: unknown }).create = async (
        ...args: unknown[]
      ) => {
        releaseBoth();
        await bothArrived;
        return (
          originalCreate as (...a: unknown[]) => Promise<FieldPolicyCollection>
        ).apply(FieldPolicyCollection, args);
      };
      results = await Promise.all([
        asManager(() =>
          nonTxSuggestions.acceptSuggestion({ id: String(promote.id) }),
        ),
        asManager(() =>
          nonTxSuggestions.acceptSuggestion({ id: String(setDefault.id) }),
        ),
      ]);
    } finally {
      (FieldPolicyCollection as unknown as { create: unknown }).create =
        originalCreate;
    }

    // Both suggestions are accepted...
    expect(results.map((result) => result.suggestion.status)).toEqual([
      'accepted',
      'accepted',
    ]);

    // ...exactly ONE policy row survives, carrying BOTH columns...
    const rows = await policies.list({
      where: {
        objectRef,
        fieldName: 'featured',
        scopeType: 'tenant',
        tenantId,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].visibility).toBe('basic');
    expect(rows[0].getDefaultValue()).toBe(true);

    // ...and BOTH returned ids resolve to that row (neither dangles).
    const survivingId = String(rows[0].id);
    expect(results.map((result) => result.policyRowId)).toEqual([
      survivingId,
      survivingId,
    ]);

    // The resolver reflects both changes for the org.
    clearFieldPolicyCache();
    const resolved = await resolveFieldPolicy(objectRef, { tenantId, db });
    expect(resolved.fields.featured.visibility).toBe('basic');
    expect(resolved.fields.featured.defaultValue).toBe(true);
  });

  it('applies a second acceptance onto an EXISTING policy row without clobbering', async () => {
    // The sequential path over a pre-existing row (e.g. one the gear created):
    // each acceptance must touch only its own column and leave the rest alone.
    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'featured',
          scopeType: 'tenant',
          tenantId,
          help: 'kept through both acceptances',
        });
      },
    );

    const promote = await seedSuggestion({ fieldName: 'featured' });
    const setDefault = await seedSuggestion({
      fieldName: 'featured',
      kind: 'default',
      proposedValue: JSON.stringify(true),
    });
    const first = await asManager(() =>
      suggestions.acceptSuggestion({ id: String(promote.id) }),
    );
    const second = await asManager(() =>
      suggestions.acceptSuggestion({ id: String(setDefault.id) }),
    );

    const rows = await policies.list({
      where: {
        objectRef,
        fieldName: 'featured',
        scopeType: 'tenant',
        tenantId,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].visibility).toBe('basic');
    expect(rows[0].getDefaultValue()).toBe(true);
    expect(rows[0].help).toBe('kept through both acceptances');
    expect(first.policyRowId).toBe(String(rows[0].id));
    expect(second.policyRowId).toBe(String(rows[0].id));
  });

  it('still refuses an accepted default whose field became gated', async () => {
    // The atomic column update bypasses the model, so the stored-default rail
    // must be re-asserted at acceptance time — a field can turn sensitive
    // between queueing and approval.
    await withTenant(
      {
        tenantId,
        userId,
        permissions: new Set([MANAGE_FIELD_POLICY_PERMISSION]),
      },
      async () => {
        await policies.create({
          objectRef,
          fieldName: 'featured',
          scopeType: 'tenant',
          tenantId,
          help: 'pre-existing row',
        });
      },
    );
    const seeded = await seedSuggestion({
      fieldName: 'featured',
      kind: 'default',
      proposedValue: JSON.stringify(true),
    });
    await db.query(
      `UPDATE _smrt_field_policy_suggestions SET field_name = ? WHERE id = ?`,
      'apiToken',
      String(seeded.id),
    );

    await expect(
      asManager(() => suggestions.acceptSuggestion({ id: String(seeded.id) })),
    ).rejects.toThrow(/sensitive, read-permission-gated, or transient/);
  });

  it('holds the active slot across a NON-TRANSACTIONAL accept (P2 regression)', async () => {
    // A database VIEW exposes `transaction` but not `beginTransaction`, so the
    // accept takes the two-step claim path. Model that by hiding
    // `beginTransaction` from the collection's db.
    const viewLike = nonTransactionalView(db);
    const nonTxSuggestions = await FieldPolicySuggestionCollection.create({
      db: viewLike,
    });
    const seeded = await seedSuggestion();
    const id = String(seeded.id);

    // Interleave generation between the claim and the policy write: it must
    // see the slot as TAKEN and create no competing pending row (which would
    // otherwise resolve against the pre-acceptance policy and collide with the
    // compensation).
    let observedDuringDecision: Array<{ status: string; activeKey: string }> =
      [];
    const originalCreate = FieldPolicyCollection.create;
    try {
      (FieldPolicyCollection as unknown as { create: unknown }).create = async (
        ...args: unknown[]
      ) => {
        const rows = await suggestions.list({ where: { tenantId } });
        observedDuringDecision = rows.map((row) => ({
          status: row.status,
          activeKey: row.activeKey,
        }));
        await runFieldPolicySuggestionGeneration({ db });
        return (
          originalCreate as (...a: unknown[]) => Promise<FieldPolicyCollection>
        ).apply(FieldPolicyCollection, args);
      };
      await asManager(() => nonTxSuggestions.acceptSuggestion({ id }));
    } finally {
      (FieldPolicyCollection as unknown as { create: unknown }).create =
        originalCreate;
    }

    // Mid-decision the row was already accepted but still HELD the slot.
    expect(observedDuringDecision).toEqual([
      { status: 'accepted', activeKey: ACTIVE_SUGGESTION_KEY },
    ]);
    // Generation created nothing in that window.
    const all = await suggestions.list({ where: { tenantId } });
    expect(all).toHaveLength(1);
    // And the slot is released once the policy is durable.
    expect(all[0].status).toBe('accepted');
    expect(all[0].activeKey).toBe(id);
    const policyRows = await policies.list({
      where: { objectRef, fieldName: 'region', scopeType: 'tenant', tenantId },
    });
    expect(policyRows).toHaveLength(1);
  });

  it('reverts a NON-TRANSACTIONAL accept whose policy write is refused', async () => {
    const viewLike = nonTransactionalView(db);
    const nonTxSuggestions = await FieldPolicySuggestionCollection.create({
      db: viewLike,
    });
    // A `default` suggestion whose stored payload cannot pass FieldPolicy
    // validation: the claim happens, the policy write is refused.
    const seeded = await seedSuggestion({
      fieldName: 'featured',
      kind: 'default',
      proposedValue: JSON.stringify(true),
    });
    const id = String(seeded.id);
    await db.query(
      `UPDATE _smrt_field_policy_suggestions SET proposed_value = ? WHERE id = ?`,
      '{not json',
      id,
    );

    await expect(
      asManager(() => nonTxSuggestions.acceptSuggestion({ id })),
    ).rejects.toThrow(/not valid JSON/);

    // Compensated back to pending, still holding its slot, with no policy row.
    const reverted = await suggestions.get(id);
    expect(reverted?.status).toBe('pending');
    expect(reverted?.activeKey).toBe(ACTIVE_SUGGESTION_KEY);
    expect(reverted?.decidedAt).toBeNull();
    expect(
      await policies.list({
        where: {
          objectRef,
          fieldName: 'featured',
          scopeType: 'tenant',
          tenantId,
        },
      }),
    ).toHaveLength(0);

    // It is still decidable afterwards (the queue is not wedged).
    const queue = await asManager(() => suggestions.pendingSuggestions());
    expect(queue.total).toBe(1);
  });

  it('dismisses a STALE suggestion whose field became gated (P2 regression)', async () => {
    const seeded = await seedSuggestion();
    // The field turns sensitive after the suggestion was queued (a redeploy).
    // Re-running proposal validation on the way out would reject the dismissal
    // and, since pending rows are never pruned, wedge it in the queue forever.
    await db.query(
      `UPDATE _smrt_field_policy_suggestions SET field_name = ? WHERE id = ?`,
      'apiToken',
      String(seeded.id),
    );

    const result = await asManager(() =>
      suggestions.dismissSuggestion({ id: String(seeded.id) }),
    );
    expect(result.suggestion.status).toBe('dismissed');
    expect(result.suggestion.cooldownUntil).not.toBeNull();

    const queue = await asManager(() => suggestions.pendingSuggestions());
    expect(queue.total).toBe(0);
  });

  it('dismisses a STALE suggestion whose object no longer exists', async () => {
    const seeded = await seedSuggestion();
    await db.query(
      `UPDATE _smrt_field_policy_suggestions SET object_ref = ? WHERE id = ?`,
      '@test/removed:GoneDoc',
      String(seeded.id),
    );

    const result = await asManager(() =>
      suggestions.dismissSuggestion({ id: String(seeded.id) }),
    );
    expect(result.suggestion.status).toBe('dismissed');

    // Acceptance of an unresolvable suggestion still fails (it would have to
    // write a policy row for a field that no longer exists) — only the exit
    // path is validation-free.
    const other = await seedSuggestion({ fieldName: 'headline' });
    await db.query(
      `UPDATE _smrt_field_policy_suggestions SET object_ref = ? WHERE id = ?`,
      '@test/removed:GoneDoc',
      String(other.id),
    );
    await expect(
      asManager(() => suggestions.acceptSuggestion({ id: String(other.id) })),
    ).rejects.toThrow(/Unknown field policy objectRef|no class with that/);
  });

  it('normal validation refuses suggestions for gated or unknown fields', async () => {
    await expect(seedSuggestion({ fieldName: 'apiToken' })).rejects.toThrow(
      /sensitive, read-permission-gated, or transient/,
    );
    await expect(seedSuggestion({ fieldName: 'nope' })).rejects.toThrow(
      /Unknown field/,
    );
    await expect(
      seedSuggestion({ kind: 'default', proposedValue: null }),
    ).rejects.toThrow(/requires a proposedValue/);
    await expect(
      seedSuggestion({
        kind: 'default',
        fieldName: 'featured',
        proposedValue: JSON.stringify('not-a-boolean'),
      }),
    ).rejects.toThrow(/must be a boolean/);
  });
});

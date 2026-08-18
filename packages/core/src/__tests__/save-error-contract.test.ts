/**
 * Regression tests for SmrtObject.save() error-contract fixes (#1378, #2366).
 *
 * 1. save()'s catch must re-throw SMRT errors AND duck-typed tenancy errors
 *    (`code === 'TENANT_ISOLATION_VIOLATION'` / 'TENANT_CONTEXT_REQUIRED')
 *    unwrapped, instead of burying them in a generic RuntimeError. The tenancy
 *    package's TenantIsolationError / TenantContextError extend plain `Error`
 *    (core cannot depend on tenancy), so they are matched by their stable code.
 * 2. Constraint-violation detection must recognize SQLite, PostgreSQL and
 *    DuckDB wording so violations map to a typed ValidationError on every
 *    adapter. We unit-test the matcher + field extractor directly (no live
 *    PG/DuckDB available here).
 * 3. (#2366) The classification must survive the adapter wrapper end to end:
 *    a real constraint violation on a real database must raise the typed
 *    error on the **first** attempt, with no retry backoff, because
 *    `@happyvertical/sql` hides the constraint wording inside
 *    `context.originalError` where the old `error.message` matcher never saw
 *    it. PostgreSQL-specific proof (25P02 inside a caller-managed
 *    transaction, 22P02 on a bad uuid) lives in
 *    `issue-2366-error-contract-postgres.optional.test.ts`.
 *
 * Uses real in-memory SQLite via getTestDatabase — no DB mocking. The retry
 * counters below wrap the real adapter methods and delegate to them; nothing
 * is stubbed.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators/index';
import {
  DatabaseError,
  RuntimeError,
  TenantIsolationError,
  ValidationError,
} from '../errors';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ conflictColumns: ['sku'] })
class ContractWidget extends SmrtObject {
  name: string = '';
  sku: string = '';
}

class ContractWidgetCollection extends SmrtCollection<ContractWidget> {
  static readonly _itemClass = ContractWidget;
}

@smrt({ conflictColumns: ['sku'] })
class ContractRequiredWidget extends SmrtObject {
  @field({ required: true })
  label: string = '';
  sku: string = '';
}

class ContractRequiredWidgetCollection extends SmrtCollection<ContractRequiredWidget> {
  static readonly _itemClass = ContractRequiredWidget;
}

/**
 * Counts calls to the real adapter write methods without replacing them.
 *
 * The whole point of #2366 is that a deterministic failure must be attempted
 * exactly once; elapsed time alone is a flaky proxy for that on shared CI
 * runners, so the attempt count is the primary assertion and timing is a
 * secondary guard against the 500 + 1000 + 2000 ms backoff returning.
 */
function countWrites(db: DatabaseInterface): {
  db: DatabaseInterface;
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const counted = new Set(['upsert', 'insert', 'update', 'get']);
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !counted.has(property)) return value;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        counts[property] = (counts[property] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db: proxy as DatabaseInterface, counts };
}

describe('save() preserves tenant error contract (#1378)', () => {
  let collection: ContractWidgetCollection;

  beforeEach(async () => {
    GlobalInterceptors.clear();
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ContractWidget'],
    });
    collection = await ContractWidgetCollection.create({ db });
  });

  afterEach(() => {
    GlobalInterceptors.clear();
  });

  // Create the object cleanly first (collection.create() itself calls save()),
  // THEN register the throwing beforeSave interceptor so the throw is observed
  // on the explicit save() under test rather than during creation.
  async function makeSavedWidget(sku: string): Promise<ContractWidget> {
    const widget = await collection.create({ name: 'W', sku });
    return widget;
  }

  it("propagates core's TenantIsolationError from save() unwrapped", async () => {
    const widget = await makeSavedWidget('s-1');
    GlobalInterceptors.register({
      name: 'tenant-guard',
      beforeSave() {
        throw TenantIsolationError.crossTenantReference({
          sourceClass: 'ContractWidget',
          fieldName: 'tenantId',
          sourceTenantId: 'tenant-a',
          targetTenantId: 'tenant-b',
        });
      },
    });

    await expect(widget.save()).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(widget.save()).rejects.toMatchObject({
      code: 'TENANT_ISOLATION_VIOLATION',
    });
  });

  it("preserves a duck-typed tenancy TenantIsolationError's code (not SmrtError)", async () => {
    // Mimics @happyvertical/smrt-tenancy's TenantIsolationError, which extends
    // plain Error and is therefore NOT instanceof core's SmrtError.
    class DuckTenantIsolationError extends Error {
      readonly code = 'TENANT_ISOLATION_VIOLATION';
      constructor() {
        super('cross-tenant write blocked');
        this.name = 'TenantIsolationError';
      }
    }

    const widget = await makeSavedWidget('s-2');
    GlobalInterceptors.register({
      name: 'tenant-guard',
      beforeSave() {
        throw new DuckTenantIsolationError();
      },
    });

    const error = await widget.save().then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(DuckTenantIsolationError);
    expect(error).not.toBeInstanceOf(RuntimeError);
    expect(error.code).toBe('TENANT_ISOLATION_VIOLATION');
  });

  it("preserves a duck-typed TenantContextError's code", async () => {
    class DuckTenantContextError extends Error {
      readonly code = 'TENANT_CONTEXT_REQUIRED';
      constructor() {
        super('no active tenant');
        this.name = 'TenantContextError';
      }
    }

    const widget = await makeSavedWidget('s-3');
    GlobalInterceptors.register({
      name: 'tenant-guard',
      beforeSave() {
        throw new DuckTenantContextError();
      },
    });

    const error = await widget.save().then(
      () => null,
      (e) => e,
    );
    expect(error.code).toBe('TENANT_CONTEXT_REQUIRED');
    expect(error).not.toBeInstanceOf(RuntimeError);
  });

  it('still wraps a genuinely unexpected non-SMRT error in RuntimeError', async () => {
    const widget = await makeSavedWidget('s-4');
    GlobalInterceptors.register({
      name: 'boom',
      beforeSave() {
        throw new Error('totally unexpected');
      },
    });

    await expect(widget.save()).rejects.toBeInstanceOf(RuntimeError);
  });
});

describe('classifyConstraintError matches all dialects (#1378)', () => {
  it('detects SQLite unique/not-null wording', () => {
    expect(
      SmrtObject.classifyConstraintError(
        'UNIQUE constraint failed: widgets.sku',
      ),
    ).toBe('unique');
    expect(
      SmrtObject.classifyConstraintError(
        'NOT NULL constraint failed: widgets.name',
      ),
    ).toBe('not_null');
  });

  it('detects PostgreSQL unique/not-null wording', () => {
    expect(
      SmrtObject.classifyConstraintError(
        'duplicate key value violates unique constraint "widgets_sku_key"',
      ),
    ).toBe('unique');
    expect(
      SmrtObject.classifyConstraintError(
        'null value in column "name" of relation "widgets" violates not-null constraint',
      ),
    ).toBe('not_null');
  });

  it('detects DuckDB constraint wording', () => {
    expect(
      SmrtObject.classifyConstraintError(
        'Constraint Error: Duplicate key "sku: abc" violates unique constraint.',
      ),
    ).toBe('unique');
    expect(
      SmrtObject.classifyConstraintError(
        'Constraint Error: Duplicate key violates primary key constraint.',
      ),
    ).toBe('unique');
    expect(
      SmrtObject.classifyConstraintError(
        'NOT NULL constraint failed: widgets.name',
      ),
    ).toBe('not_null');
  });

  it('does not misclassify DuckDB foreign-key/check violations as unique (#1578)', () => {
    // DuckDB phrases FK and CHECK failures with the same "Constraint Error ...
    // violates" shape as unique violations. They must fall through to null so
    // save() preserves the original DatabaseError instead of throwing a bogus
    // ValidationError.uniqueConstraint('unknown_field').
    expect(
      SmrtObject.classifyConstraintError(
        'Constraint Error: Violates foreign key constraint because key "owner_id: 7" does not exist in the referenced table',
      ),
    ).toBeNull();
    expect(
      SmrtObject.classifyConstraintError(
        'Constraint Error: CHECK constraint failed: price_positive',
      ),
    ).toBeNull();
  });

  it('returns null for unrelated / empty messages', () => {
    expect(
      SmrtObject.classifyConstraintError('some unrelated database error'),
    ).toBeNull();
    expect(SmrtObject.classifyConstraintError('')).toBeNull();
  });
});

describe('extractConstraintField recovers the column across dialects (#1378)', () => {
  it('extracts from SQLite/DuckDB wording', async () => {
    const widget = await makeWidget();
    expect(
      widget.publicExtractConstraintField(
        'UNIQUE constraint failed: widgets.sku',
      ),
    ).toBe('sku');
  });

  it('extracts from PostgreSQL not-null wording', async () => {
    const widget = await makeWidget();
    expect(
      widget.publicExtractConstraintField(
        'null value in column "email" of relation "widgets" violates not-null constraint',
      ),
    ).toBe('email');
  });

  it('extracts from a PostgreSQL unique DETAIL line', async () => {
    const widget = await makeWidget();
    expect(
      widget.publicExtractConstraintField('Key (sku)=(abc) already exists.'),
    ).toBe('sku');
  });
});

describe('save() surfaces real constraint violations without retrying (#2366)', () => {
  let counts: Record<string, number>;
  let collection: ContractWidgetCollection;

  beforeEach(async () => {
    GlobalInterceptors.clear();
    const raw = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ContractWidget'],
    });
    const counted = countWrites(raw);
    counts = counted.counts;
    collection = await ContractWidgetCollection.create({ db: counted.db });
  });

  afterEach(() => {
    GlobalInterceptors.clear();
  });

  it('raises a typed unique ValidationError on a primary-key collision', async () => {
    // Strict-insert mode makes the id the row identity, so a repeated id is a
    // genuine PK collision rather than an upsert that adopts the existing row.
    // This is the exact probe from the issue: it used to surface as a generic
    // DatabaseError after ~3.5s of backoff.
    const id = crypto.randomUUID();
    await collection.create({
      id,
      name: 'First',
      sku: 'pk-1',
      _insertOnly: true,
    });

    const before = counts.insert ?? 0;
    const started = Date.now();
    const error = await collection
      .create({ id, name: 'Second', sku: 'pk-2', _insertOnly: true })
      .then(
        () => null,
        (thrown) => thrown,
      );
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('VALIDATION_UNIQUE_CONSTRAINT');
    // The column name only exists inside the adapter's nested `originalError`
    // string, so a chain-blind extractor reports 'unknown_field' here.
    expect(error.details?.fieldName).toBe('id');
    // One attempt: the deterministic failure is never retried.
    expect((counts.insert ?? 0) - before).toBe(1);
    // Guards the 500 + 1000 + 2000 ms backoff, with wide CI headroom.
    expect(elapsed).toBeLessThan(1000);
  });

  it('names the violated natural-key column, not unknown_field', async () => {
    await collection.create({ name: 'A', sku: 'dup-sku', _insertOnly: true });

    const before = counts.insert ?? 0;
    const error = await collection
      .create({ name: 'B', sku: 'dup-sku', _insertOnly: true })
      .then(
        () => null,
        (thrown) => thrown,
      );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('VALIDATION_UNIQUE_CONSTRAINT');
    expect(error.details?.fieldName).toBe('sku');
    expect((counts.insert ?? 0) - before).toBe(1);
  });

  it('still retries a genuinely transient failure', async () => {
    // The fix must not turn withRetry into an allow-list that stops retrying
    // everything it cannot classify — a dropped pool connection must still be
    // survivable.
    let faultsRemaining = 0;
    let attempts = 0;
    const raw = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ContractWidget'],
    });
    const flaky = new Proxy(raw, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'upsert' || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          attempts++;
          if (faultsRemaining > 0) {
            faultsRemaining--;
            throw Object.assign(new Error('read ECONNRESET'), {
              code: 'ECONNRESET',
            });
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DatabaseInterface;

    const flakyCollection = await ContractWidgetCollection.create({
      db: flaky,
    });
    const widget = await flakyCollection.create({
      name: 'T',
      sku: 'transient-1',
    });

    // Arm the fault only for the explicit save under test.
    attempts = 0;
    faultsRemaining = 1;
    widget.name = 'T2';
    await expect(widget.save()).resolves.toBe(widget);
    expect(attempts).toBe(2);
  });
});

describe('save() surfaces a NOT NULL violation as a typed error (#2366)', () => {
  let counts: Record<string, number>;
  let collection: ContractRequiredWidgetCollection;

  beforeEach(async () => {
    GlobalInterceptors.clear();
    const raw = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ContractRequiredWidget'],
    });
    const counted = countWrites(raw);
    counts = counted.counts;
    collection = await ContractRequiredWidgetCollection.create({
      db: counted.db,
    });
  });

  afterEach(() => {
    GlobalInterceptors.clear();
  });

  it('maps the database NOT NULL failure to VALIDATION_REQUIRED_FIELD', async () => {
    // A beforeSave interceptor runs after validateBeforeSave(), so this
    // reaches the database with a NULL in a NOT NULL column — the real driver
    // failure, not a model-level validation short-circuit.
    GlobalInterceptors.register({
      name: 'null-the-label',
      beforeSave(instance: unknown) {
        (instance as { label: string | null }).label = null;
      },
    });

    const before = counts.upsert ?? 0;
    const started = Date.now();
    const error = await collection.create({ label: 'set', sku: 'nn-1' }).then(
      () => null,
      (thrown) => thrown,
    );
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('VALIDATION_REQUIRED_FIELD');
    expect(error.details?.fieldName).toBe('label');
    expect((counts.upsert ?? 0) - before).toBe(1);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('loadFromId() does not retry a deterministic failure (#2366)', () => {
  it('raises a DatabaseError once, preserving the driver cause', async () => {
    const raw = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ContractWidget'],
    });

    // Reproduces the shape `@happyvertical/sql` actually throws: the driver
    // detail lives in `context.originalError` as a formatted string, never in
    // the wrapper's own message.
    let gets = 0;
    let faulty = false;
    const proxy = new Proxy(raw, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'get' || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (!faulty) {
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          }
          gets++;
          throw Object.assign(
            new Error('Failed to retrieve record from table'),
            {
              code: 'DATABASE_ERROR',
              context: {
                originalError:
                  'invalid input syntax for type uuid: "not-a-uuid", code=22P02, severity=ERROR',
              },
            },
          );
        };
      },
    }) as DatabaseInterface;

    const widget = new ContractWidget({
      db: proxy,
      name: 'X',
      sku: 'x',
      _skipLoad: true,
    });
    await widget.initialize();
    widget._id = 'not-a-uuid';

    faulty = true;
    const started = Date.now();
    const error = await widget.loadFromId().then(
      () => null,
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.cause).toBeInstanceOf(Error);
    // Was three attempts at 250 ms backoff for a literal that can never parse.
    expect(gets).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/** Helper exposing the protected extractConstraintField for assertions. */
class TestableWidget extends ContractWidget {
  publicExtractConstraintField(message: string): string {
    return this.extractConstraintField(message);
  }
}

async function makeWidget(): Promise<TestableWidget> {
  const widget = new TestableWidget({ name: 'X', sku: 'x', _skipLoad: true });
  await widget.initialize();
  return widget;
}

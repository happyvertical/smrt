/**
 * Regression tests for SmrtObject.save() error-contract fixes (#1378).
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
 *
 * Uses real in-memory SQLite via getTestDatabase — no DB mocking.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { RuntimeError, TenantIsolationError } from '../errors';
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

/**
 * Rows written under a provider's qualified name stay reachable after a
 * same-name app subclass replaces that class: STI child reads, polymorphic
 * `metaType` filters, delete cascades, doctor counts and the qualified-name
 * backfill all use the registry's one equivalence set
 * (`ObjectRegistry.getEquivalentQualifiedNames`). Runs on SQLite by default
 * and on PGlite under `pnpm test:pglite`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators';
import {
  backfillLegacyQualifiedNames,
  countLegacyQualifiedNameReferences,
} from '../migrations/qualified-name-aliases';
import { SmrtObject } from '../object';
import { SmrtPolymorphicAssociation } from '../polymorphic-association';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database.js';

const UP = '@replaced-eq/provider';
const APP = '@replaced-eq/app';
const UP_CUSTOMER = `${UP}:ReplacedEqCustomer`;
const UP_CONTRACT = `${UP}:ReplacedEqContract`;
const UP_AGREEMENT = `${UP}:ReplacedEqAgreement`;
const UP_ATTACHMENT = `${UP}:ReplacedEqAttachment`;
const APP_CUSTOMER = `${APP}:ReplacedEqCustomer`;
const APP_AGREEMENT = `${APP}:ReplacedEqAgreement`;

function defineProvider() {
  @smrt({ packageName: UP, tableName: 'replaced_eq_customers' } as any)
  class ReplacedEqCustomer extends SmrtObject {
    @field({ type: 'text' }) title = '';
  }
  @smrt({
    packageName: UP,
    tableName: 'replaced_eq_contracts',
    tableStrategy: 'sti',
  } as any)
  class ReplacedEqContract extends SmrtObject {
    @field({ type: 'text' }) title = '';
  }
  @smrt({ packageName: UP } as any)
  class ReplacedEqAgreement extends ReplacedEqContract {
    @field({ type: 'text' }) terms = '';
  }
  @smrt({
    packageName: UP,
    tableName: 'replaced_eq_attachments',
    conflictColumns: ['note', 'meta_type', 'meta_id', 'role'],
  } as any)
  class ReplacedEqAttachment extends SmrtPolymorphicAssociation {
    @field({ type: 'text' }) note = '';
    // Framework-base columns normally arrive via the scanned manifest.
    @field({ type: 'text' }) declare metaType: string;
    @field({ type: 'text' }) declare metaId: string;
    @field({ type: 'text' }) declare role: string;
    @field({ type: 'integer' }) declare sortOrder: number;
  }
  return { Customer: ReplacedEqCustomer, Agreement: ReplacedEqAgreement };
}

function defineApp(provider: ReturnType<typeof defineProvider>) {
  // Same simple name, empty body (agents/app-subclasses.md). The provider
  // table is explicit, as the generated consumer manifest supplies it.
  @smrt({ packageName: APP, tableName: 'replaced_eq_customers' } as any)
  class ReplacedEqCustomer extends provider.Customer {}
  @smrt({ packageName: APP } as any)
  class ReplacedEqAgreement extends provider.Agreement {}
  return { Customer: ReplacedEqCustomer, Agreement: ReplacedEqAgreement };
}

type Engine = 'sqlite' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite'];

describe.each(engines)('replaced qualified names on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let customerId: string;
  let agreementId: string;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    const provider = defineProvider();
    db = await getTestDatabase({
      type: engine,
      ...(engine === 'sqlite' ? { url: ':memory:' } : {}),
      classes: [UP_CUSTOMER, UP_CONTRACT, UP_AGREEMENT, UP_ATTACHMENT],
    });
    const customers: any = await ObjectRegistry.getCollection(UP_CUSTOMER, {
      db,
    });
    const customer = await customers.create({ title: 'stored customer' });
    await customer.save();
    customerId = String(customer.id);
    const agreements: any = await ObjectRegistry.getCollection(UP_AGREEMENT, {
      db,
    });
    const agreement = await agreements.create({ title: 'stored', terms: 't' });
    await agreement.save();
    agreementId = String(agreement.id);
    const attachments: any = await ObjectRegistry.getCollection(UP_ATTACHMENT, {
      db,
    });
    await (
      await attachments.create({
        metaType: UP_CUSTOMER,
        metaId: customerId,
        note: 'stored',
      })
    ).save();
    defineApp(provider);
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  it('control: the app subclass is the effective identity', () => {
    expect(ObjectRegistry.resolveQualifiedName(UP_CUSTOMER)).toBe(APP_CUSTOMER);
    expect(ObjectRegistry.resolveQualifiedName(UP_AGREEMENT)).toBe(
      APP_AGREEMENT,
    );
  });

  it('lists the equivalent names: current first, then the replaced name', () => {
    expect(ObjectRegistry.getEquivalentQualifiedNames(APP_CUSTOMER)).toEqual([
      APP_CUSTOMER,
      UP_CUSTOMER,
    ]);
    expect(ObjectRegistry.getEquivalentQualifiedNames(UP_CUSTOMER)).toEqual([
      APP_CUSTOMER,
      UP_CUSTOMER,
    ]);
  });

  it('an STI child collection still reads rows stored under the replaced name', async () => {
    const agreements: any = await ObjectRegistry.getCollection(APP_AGREEMENT, {
      db,
    });
    expect((await agreements.list({})).map((row: any) => row.id)).toEqual([
      agreementId,
    ]);
    expect(await agreements.get({ id: agreementId })).not.toBeNull();
    expect(agreements.getStiChildMetaTypes()).toEqual([
      APP_AGREEMENT,
      UP_AGREEMENT,
    ]);

    const fresh = await agreements.create({ title: 'fresh', terms: 'n' });
    await fresh.save();
    expect((await agreements.list({})).length).toBe(2);
  });

  it('a polymorphic metaType filter by either name finds the stored row', async () => {
    const attachments: any = await ObjectRegistry.getCollection(UP_ATTACHMENT, {
      db,
    });
    for (const name of [UP_CUSTOMER, APP_CUSTOMER]) {
      const names = await ObjectRegistry.getEquivalentQualifiedNamesAsync(name);
      const rows = await attachments.list({
        where: { 'metaType in': names, metaId: customerId },
      });
      expect(rows.map((row: any) => row.note)).toEqual(['stored']);
    }
  });

  it('deleting the owner removes association rows stored under the replaced name', async () => {
    const customers: any = await ObjectRegistry.getCollection(APP_CUSTOMER, {
      db,
    });
    const owner = await customers.get({ id: customerId });
    await owner.delete();
    const remaining = await db.query(
      'SELECT note FROM replaced_eq_attachments',
    );
    expect(remaining.rows).toEqual([]);
  });

  it('doctor counts and the backfill rewrite rows stored under the replaced name', async () => {
    const report = await countLegacyQualifiedNameReferences(db);
    expect(
      report.references.map(({ table, column, alias, current, count }) => ({
        table,
        column,
        alias,
        current,
        count,
      })),
    ).toEqual([
      {
        table: 'replaced_eq_attachments',
        column: 'meta_type',
        alias: UP_CUSTOMER,
        current: APP_CUSTOMER,
        count: 1,
      },
      {
        table: 'replaced_eq_contracts',
        column: '_meta_type',
        alias: UP_AGREEMENT,
        current: APP_AGREEMENT,
        count: 1,
      },
    ]);

    const result = await backfillLegacyQualifiedNames(db);
    expect(result.rewritten.map((entry) => entry.count)).toEqual([1, 1]);
    expect((await countLegacyQualifiedNameReferences(db)).total).toBe(0);
    const contracts = await db.query(
      'SELECT _meta_type FROM replaced_eq_contracts',
    );
    expect(contracts.rows).toEqual([{ _meta_type: APP_AGREEMENT }]);
  });

  it('control: the plain base collection reads the stored row', async () => {
    const customers: any = await ObjectRegistry.getCollection(APP_CUSTOMER, {
      db,
    });
    expect((await customers.list({})).length).toBe(1);
  });
});

/** Exact fractional invoice persistence and explicit legacy-column migration on supported engines. */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import {
  type InvoiceEditorStorageEngine,
  migrateInvoiceEditorStorage,
  preflightInvoiceEditorStorage,
} from '../migrations/invoiceEditorStorage.js';
import { InvoiceLineItem } from '../models/InvoiceLineItem.js';
import type { InvoiceLineDraft } from '../svelte/invoices/calculations.js';

const context = { currency: 'CAD', inheritedTaxRate: '5' };
const draft: InvoiceLineDraft = {
  key: 'line-1',
  description: 'Consulting',
  sku: 'HOUR',
  quantity: '1.25',
  unitPrice: '100.00',
  discountType: 'percent',
  discountValue: '10',
  taxMode: 'inherit',
  taxRate: '',
};

describe('invoice quantity arithmetic and validation', () => {
  it('keeps an explicit zero tax rate at the accounting boundary', () => {
    const item = new InvoiceLineItem();
    item.applyEditorDraft(
      { ...draft, taxMode: 'override', taxRate: '0' },
      context,
    );
    expect(item.toAccountingLineItem('CAD')).toMatchObject({
      taxRate: 0,
      amount: 112.5,
    });
    expect(item.toAccountingLineItem()).toMatchObject({
      taxRate: 0,
      amount: 11250,
    });
  });
  it('rounds fractional gross and credit tax ties toward positive infinity', () => {
    const item = new InvoiceLineItem({
      quantity: 0.5,
      unitPrice: 3,
      taxRate: 0.5,
    });
    expect([
      item.getSubtotal(),
      item.getTaxAmount(),
      item.calculateAmount(),
    ]).toEqual([2, 1, 3]);
    item.unitPrice = -3;
    expect([
      item.getSubtotal(),
      item.getTaxAmount(),
      item.calculateAmount(),
    ]).toEqual([-1, 0, -1]);
  });
  it.each([
    { quantity: -1 },
    { quantity: Number.NaN },
    { quantity: 0.0000001 },
    { unitPrice: 0.5 },
    { unitPrice: Number.MAX_SAFE_INTEGER + 1 },
    { discount: -1 },
    { discount: 0.5 },
    { taxRate: 1.01 },
    { taxRate: Number.NaN },
    { quantity: 2, unitPrice: Number.MAX_SAFE_INTEGER },
  ])('refuses invalid fields before any persistence: %j', async (fields) => {
    const item = new InvoiceLineItem({
      quantity: 1,
      unitPrice: 100,
      ...fields,
    });
    expect(() => item.calculateAmount()).toThrow(RangeError);
    await expect(item.save()).rejects.toThrow(RangeError);
  });
  it('clones editor state and rejects stale authority/source fields', () => {
    const item = new InvoiceLineItem();
    const input = structuredClone(draft);
    item.applyEditorDraft(input, context);
    input.discountValue = '99';
    expect(item.getEditorDraft(context)?.discountValue).toBe('10');
    expect(item.getEditorDraft({ ...context, currency: 'USD' })).toBeNull();
    expect(
      item.getEditorDraft({ ...context, inheritedTaxRate: '6' }),
    ).toBeNull();
    const reopened = item.getEditorDraft(context)!;
    reopened.quantity = '9';
    expect(item.quantity).toBe(1.25);
    item.quantity = 2;
    expect(item.getEditorDraft(context)).toBeNull();
  });
});

/** Each PostgreSQL test owns a unique schema, including all DDL and committed writes. */
async function createInvoiceTestDatabase(
  engine: InvoiceEditorStorageEngine,
  classes: string[],
): Promise<{ db: DatabaseInterface; cleanup: () => Promise<void> }> {
  if (engine !== 'postgres') {
    const db = await getTestDatabase({
      type: engine,
      url: ':memory:',
      classes,
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  }
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl)
    throw new Error('PostgreSQL invoice tests require DATABASE_URL.');
  const admin = await getTestDatabase({
    type: 'postgres',
    url: baseUrl,
    classes: [],
  });
  const schema = `invoice_quantity_${randomUUID().replaceAll('-', '')}`;
  let db: DatabaseInterface | undefined;
  const cleanup = async () => {
    try {
      await db?.close?.();
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.close?.();
      }
    }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(baseUrl);
    const options = url.searchParams.get('options');
    url.searchParams.set(
      'options',
      `${options ? `${options} ` : ''}-c search_path=${schema}`,
    );
    db = await getTestDatabase({
      type: 'postgres',
      url: url.toString(),
      classes,
    });
    expect(
      (await db.query('SELECT current_schema() AS name')).rows[0].name,
    ).toBe(schema);
    return { db, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const engines: InvoiceEditorStorageEngine[] = [
  'sqlite',
  'duckdb',
  ...(isPostgresAvailable() ? ['postgres' as const] : []),
];
for (const engine of engines) {
  if (engine !== 'duckdb')
    describe(`invoice fractional persistence on ${engine}`, () => {
      let db: DatabaseInterface | undefined;
      let cleanup: (() => Promise<void>) | undefined;
      afterEach(async () => {
        await cleanup?.();
        db = undefined;
        cleanup = undefined;
      });
      it('persists canonical large fractional quantity without a one-cent rounding loss', async () => {
        const isolated = await createInvoiceTestDatabase(engine, [
          'Customer',
          'Vendor',
          'Contract',
          'ContractLineItem',
          'Invoice',
          'InvoiceLineItem',
          'Payment',
          'PaymentAllocation',
        ]);
        db = isolated.db;
        cleanup = isolated.cleanup;
        const invoices = await InvoiceCollection.create({ db });
        const invoice = await invoices.create({
          invoiceNumber: 'CANONICAL-QUANTITY',
        });
        const lines = await InvoiceLineItemCollection.create({ db });
        const item = await lines.create({
          invoiceId: invoice.id,
          quantity: 10000000000.12345,
          unitPrice: 90000,
          discount: 0,
          taxRate: 0,
          amount: 1,
        });
        expect(item.amount).toBe(900000000011111);
        const loaded = await lines.get(item.id);
        expect(loaded?.quantity).toBe(10000000000.12345);
        expect(loaded?.amount).toBe(900000000011111);
        expect(loaded?.calculateAmount()).toBe(900000000011111);
      });
      it('roundtrips fractional quantity and editor modes, ignores forged amount and clears stale draft', async () => {
        const isolated = await createInvoiceTestDatabase(engine, [
          'Customer',
          'Vendor',
          'Contract',
          'ContractLineItem',
          'Invoice',
          'InvoiceLineItem',
          'Payment',
          'PaymentAllocation',
        ]);
        db = isolated.db;
        cleanup = isolated.cleanup;
        const invoices = await InvoiceCollection.create({ db });
        const invoice = await invoices.create({ invoiceNumber: 'FRACTIONAL' });
        const lines = await InvoiceLineItemCollection.create({ db });
        const item = await lines.create({
          invoiceId: invoice.id,
          quantity: 1.25,
          unitPrice: 10000,
          amount: 999,
        });
        expect(item.amount).toBe(12500);
        item.applyEditorDraft(draft, context);
        await item.save();
        const loaded = await lines.get(item.id);
        expect(loaded?.quantity).toBe(1.25);
        expect(loaded?.amount).toBe(11813);
        expect(loaded?.getEditorDraft(context)).toEqual(draft);
        loaded!.amount = 1;
        loaded!.quantity = 2.5;
        await loaded!.save();
        const updated = await lines.get(item.id);
        expect(updated?.amount).toBe(24938);
        expect(updated?.invoiceEditorState).toBeNull();
        updated!.invoiceEditorStateJson = '{invalid';
        expect(updated!.getEditorDraft(context)).toBeNull();
        await updated!.save();
        expect(updated!.invoiceEditorStateJson).toBe('');
        expect(updated!.amount).toBe(24938);
      });
    });
  describe(`legacy quantity migration on ${engine}`, () => {
    let db: DatabaseInterface | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await cleanup?.();
      db = undefined;
      cleanup = undefined;
    });
    async function setup(type = 'INTEGER') {
      const isolated = await createInvoiceTestDatabase(engine, []);
      db = isolated.db;
      cleanup = isolated.cleanup;
      await db.query(
        `CREATE TABLE invoice_line_items (id VARCHAR PRIMARY KEY, quantity ${type})`,
      );
      return db;
    }
    it('preserves old values, supports new fractions, and is idempotent', async () => {
      const database = await setup();
      await database.query(
        "INSERT INTO invoice_line_items (id, quantity) VALUES ('old', 3)",
      );
      const first = await migrateInvoiceEditorStorage(database, engine);
      expect(first.changed).toBe(true);
      const after = await preflightInvoiceEditorStorage(database, engine);
      expect(after.declaredType?.toLowerCase()).toBe(
        engine === 'sqlite'
          ? 'real'
          : engine === 'postgres'
            ? 'double precision'
            : 'double',
      );
      expect(after.editorStateColumnPresent).toBe(true);
      expect(
        (
          await database.query(
            "SELECT quantity FROM invoice_line_items WHERE id = 'old'",
          )
        ).rows[0].quantity,
      ).toBe(3);
      await database.query(
        "INSERT INTO invoice_line_items (id, quantity) VALUES ('fractional', 1.25)",
      );
      expect(
        (
          await database.query(
            "SELECT quantity FROM invoice_line_items WHERE id = 'fractional'",
          )
        ).rows[0].quantity,
      ).toBe(1.25);
      await database.query(
        "INSERT INTO invoice_line_items (id,quantity) VALUES ('six-places', 123456789.123456)",
      );
      expect((await preflightInvoiceEditorStorage(database, engine)).ok).toBe(
        true,
      );
      expect(
        (await migrateInvoiceEditorStorage(database, engine)).changed,
      ).toBe(false);
    });
    it('preflights canonical large fractional storage without inventing decimal digits', async () => {
      const database = await setup('DOUBLE PRECISION');
      await database.query(
        "INSERT INTO invoice_line_items (id,quantity) VALUES ('canonical', 10000000000.12345)",
      );
      expect((await preflightInvoiceEditorStorage(database, engine)).ok).toBe(
        true,
      );
      await migrateInvoiceEditorStorage(database, engine);
      expect(
        (
          await database.query(
            "SELECT quantity FROM invoice_line_items WHERE id='canonical'",
          )
        ).rows[0].quantity,
      ).toBe(10000000000.12345);
    });
    if (engine !== 'sqlite')
      it('rejects original decimal storage that cannot roundtrip through Number', async () => {
        const database = await setup('DECIMAL(30,10)');
        await database.query(
          "INSERT INTO invoice_line_items (id,quantity) VALUES ('lossy', 9007199254740990.1)",
        );
        expect(
          (await preflightInvoiceEditorStorage(database, engine)).invalidRowIds,
        ).toEqual(['lossy']);
        await expect(
          migrateInvoiceEditorStorage(database, engine),
        ).rejects.toThrow(/refused/);
      });
    it('refuses invalid rows without rounding them or changing the declaration', async () => {
      const database = await setup('DOUBLE PRECISION');
      await database.query(
        "INSERT INTO invoice_line_items (id, quantity) VALUES ('negative', -1), ('precision', 0.0000001)",
      );
      const report = await preflightInvoiceEditorStorage(database, engine);
      expect(report.ok).toBe(false);
      expect(report.invalidRowIds.sort()).toEqual(['negative', 'precision']);
      await expect(
        migrateInvoiceEditorStorage(database, engine),
      ).rejects.toThrow(/refused/);
      expect(
        (
          await database.query(
            "SELECT quantity FROM invoice_line_items WHERE id = 'precision'",
          )
        ).rows[0].quantity,
      ).toBe(0.0000001);
    });
  });
}

describe('SQLite invoice storage rebuild safety', () => {
  let db: DatabaseInterface | undefined;
  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });
  it('preserves unrelated columns, indexes, triggers and CHECK constraints', async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await db.query(
      "CREATE TABLE invoice_line_items (id TEXT PRIMARY KEY, quantity INTEGER CHECK(quantity >= 0), note TEXT DEFAULT 'retained')",
    );
    await db.query('CREATE INDEX invoice_note_idx ON invoice_line_items(note)');
    await db.query('CREATE TABLE quantity_audit (id TEXT)');
    await db.query(
      'CREATE TRIGGER invoice_quantity_audit AFTER INSERT ON invoice_line_items BEGIN INSERT INTO quantity_audit VALUES (NEW.id); END',
    );
    await db.query(
      "INSERT INTO invoice_line_items (id, quantity) VALUES ('old', 2)",
    );
    await migrateInvoiceEditorStorage(db, 'sqlite');
    expect(
      (await db.query("SELECT note FROM invoice_line_items WHERE id='old'"))
        .rows[0].note,
    ).toBe('retained');
    await db.query(
      "INSERT INTO invoice_line_items (id,quantity) VALUES ('new', 1.25)",
    );
    expect(
      (await db.query('SELECT id FROM quantity_audit ORDER BY id')).rows.map(
        (row) => row.id,
      ),
    ).toEqual(['new', 'old']);
    expect(
      (
        await db.query(
          "SELECT name FROM sqlite_master WHERE name='invoice_note_idx'",
        )
      ).rows,
    ).toHaveLength(1);
    await expect(
      db.query(
        "INSERT INTO invoice_line_items (id,quantity) VALUES ('invalid', -1)",
      ),
    ).rejects.toThrow();
  });
  it('refuses incoming cascades and leaves parent and child data intact', async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await db.query('PRAGMA foreign_keys=ON');
    await db.query(
      'CREATE TABLE invoice_line_items (id TEXT PRIMARY KEY, quantity INTEGER)',
    );
    await db.query(
      'CREATE TABLE quantity_child (id TEXT, parent_id TEXT REFERENCES invoice_line_items(id) ON DELETE CASCADE)',
    );
    await db.query("INSERT INTO invoice_line_items VALUES ('old', 2)");
    await db.query("INSERT INTO quantity_child VALUES ('child', 'old')");
    await expect(migrateInvoiceEditorStorage(db, 'sqlite')).rejects.toThrow(
      /explicit maintenance/,
    );
    expect((await db.query('SELECT * FROM quantity_child')).rows).toHaveLength(
      1,
    );
    expect(
      (await preflightInvoiceEditorStorage(db, 'sqlite')).declaredType,
    ).toBe('INTEGER');
  });
  it('rejects unsafe integer data without a lossy cast', async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await db.query(
      'CREATE TABLE invoice_line_items (id TEXT PRIMARY KEY, quantity INTEGER)',
    );
    await db.query(
      "INSERT INTO invoice_line_items VALUES ('unsafe', 9007199254740993)",
    );
    await expect(migrateInvoiceEditorStorage(db, 'sqlite')).rejects.toThrow(
      /unsafe/,
    );
    expect(
      (
        await db.query(
          'SELECT CAST(quantity AS TEXT) AS quantity FROM invoice_line_items',
        )
      ).rows[0].quantity,
    ).toBe('9007199254740993');
  });
});

/**
 * PostgreSQL round-trip proof for `Product.price` (#2361).
 *
 * `price = 0` compiles to an INTEGER column, so a catalog price of `19.99`
 * failed on PostgreSQL with `22P02 invalid input syntax for type integer`.
 * SQLite's affinity stored it regardless, which is exactly why this package's
 * SQLite-only suites never saw it. `Product` is an STI base, so the column is
 * shared by every consumer subtype on the `products` table.
 */

import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaterialCollection } from './lib/collections/MaterialCollection';
import { ProductCollection } from './lib/collections/ProductCollection';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('products price column on PostgreSQL (#2361)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let products: ProductCollection;
  let materials: MaterialCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Product', 'Material'],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    db = isolated.baseDb;
    products = await ProductCollection.create({ db });
    materials = await MaterialCollection.create({ db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('declares the shared price column as a floating-point type', async () => {
    const result = await db.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'products' AND column_name = 'price'`,
    );

    const rows = result.rows as { data_type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toMatch(/double precision|real|numeric/);
  });

  it('round-trips a fractional catalog price', async () => {
    const product = await products.create({
      name: 'Widget',
      slug: 'widget-2361',
      price: 19.99,
    });

    expect((await products.get(product.id))?.price).toBeCloseTo(19.99, 6);
  });

  it('round-trips a fractional price on an STI subtype', async () => {
    // `Material` shares the `products` table, so it exercises the same column
    // through the discriminated path consumers actually use.
    const material = await materials.create({
      name: 'Cotton twill',
      slug: 'cotton-twill-2361',
      price: 4.25,
      costPerUnit: 2.75,
    });

    const reloaded = await materials.get(material.id);
    expect(reloaded?.price).toBeCloseTo(4.25, 6);
    expect(reloaded?.costPerUnit).toBeCloseTo(2.75, 6);
  });
});

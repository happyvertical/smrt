/**
 * PostgreSQL lane for `Product.price` (#2361).
 *
 * Price is **integer minor units** (cents, satoshis) — `$19.99` is `1999`.
 * `Product` is the STI base, so the column is shared by every consumer subtype,
 * which makes a silent unit mistake here especially expensive.
 *
 * SQLite's type affinity stores a fractional write into an INTEGER column
 * without complaint, so only a real PostgreSQL lane can prove the boundary
 * actually holds.
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

  it('declares the shared price column as an integer type', async () => {
    const result = await db.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'products' AND column_name = 'price'`,
    );

    const rows = result.rows as { data_type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toMatch(/integer|bigint/);
  });

  it('round-trips a price as exact integer minor units', async () => {
    const product = await products.create({
      name: 'Widget',
      slug: 'widget-2361',
      price: 1999, // $19.99
    });

    // Exact equality — minor units are exact by construction.
    expect((await products.get(product.id))?.price).toBe(1999);
  });

  it('rejects a fractional major-unit price instead of silently storing it', async () => {
    await expect(
      products.create({
        name: 'Fractional',
        slug: 'fractional-2361',
        price: 19.99,
      }),
    ).rejects.toThrow();
  });

  it('shares the column with an STI subtype', async () => {
    // `Material` lives on the same `products` table, so it exercises the same
    // column through the discriminated path consumers actually use.
    // `costPerUnit` is a `Meta<number>` in `_meta_data`, not a column, so it is
    // outside the minor-units rule and stays decimal.
    const material = await materials.create({
      name: 'Cotton twill',
      slug: 'cotton-twill-2361',
      price: 425, // $4.25
      costPerUnit: 2.75,
    });

    const reloaded = await materials.get(material.id);
    expect(reloaded?.price).toBe(425);
    expect(reloaded?.costPerUnit).toBeCloseTo(2.75, 6);
  });
});

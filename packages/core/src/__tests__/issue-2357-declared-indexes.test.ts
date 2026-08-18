/**
 * Issue #2357: `@smrt({ indexes: [...] })` must reach schema generation.
 *
 * `generator-branches.test.ts` proves the generator honours a declaration on
 * every path. This file covers the delivery bug that made the option
 * unreachable in the first place: the runtime sites rebuild the generator's
 * config bag by hand (`schema/utils.ts`, `testing/database.ts`) rather than
 * passing `@smrt()` config through, so an option they forget to list is
 * silently dropped even though it is present in the manifest.
 *
 * These tests therefore go through the real registry and the real test-database
 * bootstrap rather than calling `SchemaGenerator` directly.
 */

import { describe, expect, it } from 'vitest';
import { SmrtObject, smrt } from '../index';
import { ObjectRegistry } from '../registry';
import { generateSchema } from '../schema/utils';
import { getTestDatabase } from '../testing/database';

// Top level so the AST scanner picks it up during test manifest generation.
@smrt({
  indexes: [
    {
      name: 'declared_index_records_owner_id_published_at_idx',
      // A list access path: filter column first, sort column last. Declared in
      // SMRT field names to prove they are mapped to column names.
      columns: ['ownerId', 'publishedAt'],
    },
    {
      name: 'declared_index_records_code_active_idx',
      columns: ['code'],
      unique: true,
      where: 'active = 1',
    },
  ],
})
class DeclaredIndexRecord extends SmrtObject {
  ownerId: string = '';
  publishedAt: string = '';
  code: string = '';
  active: boolean = false;
}

describe('Issue #2357: declared indexes survive the runtime config rebuild', () => {
  it('reaches schema generation through the registry (schema/utils.ts)', async () => {
    await generateSchema(DeclaredIndexRecord);

    const registered = ObjectRegistry.getClass('DeclaredIndexRecord');
    const declared = registered?.schema?.indexes.find(
      (index) =>
        index.name === 'declared_index_records_owner_id_published_at_idx',
    );

    expect(declared).toBeDefined();
    expect(declared?.columns).toEqual(['owner_id', 'published_at']);
  });

  it('carries unique and partial-index options through the same path', async () => {
    await generateSchema(DeclaredIndexRecord);

    const registered = ObjectRegistry.getClass('DeclaredIndexRecord');
    const partial = registered?.schema?.indexes.find(
      (index) => index.name === 'declared_index_records_code_active_idx',
    );

    expect(partial?.unique).toBe(true);
    expect(partial?.where).toBe('active = 1');
  });

  it('materializes the composite index in a test database (testing/database.ts)', async () => {
    const db = await getTestDatabase({ classes: ['DeclaredIndexRecord'] });

    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'declared_index_records';",
    );
    const names = indexes.rows.map((row) => row.name);

    expect(names).toContain('declared_index_records_owner_id_published_at_idx');
    expect(names).toContain('declared_index_records_code_active_idx');
  });
});

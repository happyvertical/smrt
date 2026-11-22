/**
 * #5455: a field that becomes required never has its existing NULLs filled
 * with a value nobody chose. Live NULLs stop the migrate with
 * `column.required-nulls` unless a backfill is given: the field's own
 * `backfill`, or the caller naming the column in `fillRequiredFromDefault`
 * (`smrt db:migrate --fill-required`). A required field that is removed leaves
 * no NOT NULL column that inserts cannot fill: migrate makes it nullable on
 * every engine and keeps its values.
 *
 * Runs on SQLite and DuckDB by default; under `pnpm test:pglite` on PGlite for
 * PostgreSQL semantics.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import { classifySchemaChange } from '../change-kinds.js';
import { SchemaComparer } from '../differ.js';
import {
  type MigrateSmrtSchemasResult,
  migrateSmrtSchemas,
} from '../orchestrate.js';

const PKG = '@required5455/app';
const TABLE = 'required_profiles';

type Engine = 'sqlite' | 'duckdb' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite', 'duckdb'];

type Shape = 'optional' | 'required' | 'removed' | 'required-no-default';

describe.each(engines)('required field changes on %s (#5455)', (engine) => {
  const hint = engine === 'pglite' ? 'postgres' : engine;
  const options =
    hint === 'postgres'
      ? { postgresSafe: false, useConcurrentIndexes: false }
      : {};
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let runs = 0;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    db =
      engine === 'pglite'
        ? await getTestDatabase({
            type: 'pglite',
            classes: [],
            includeSystemTables: false,
          })
        : ((await getDatabase({
            type: engine,
            url: ':memory:',
          })) as typeof db);
  });
  afterEach(async () => {
    await db.close?.();
    restore();
  });

  const migrate = (
    extra: Partial<Parameters<typeof migrateSmrtSchemas>[0]> = {},
  ): Promise<MigrateSmrtSchemasResult> =>
    migrateSmrtSchemas({
      db,
      packageName: PKG,
      name: `required_${++runs}`,
      engineHint: hint,
      ...options,
      ...extra,
    });
  /** `email` as the shape names it; `title` is always there. */
  const register = (shape: Shape) => {
    ObjectRegistry.clear();
    class RequiredProfile extends SmrtObject {
      title = '';
      email = '';
    }
    field({ type: 'text' })(RequiredProfile.prototype, 'title');
    if (shape !== 'removed')
      field(
        shape === 'optional'
          ? { type: 'text' }
          : shape === 'required'
            ? // What the scanner gives `@field({ required: true }) email = ''`.
              { type: 'text', required: true, default: '' }
            : { type: 'text', required: true, default: null as never },
      )(RequiredProfile.prototype, 'email');
    ObjectRegistry.register(RequiredProfile, {
      packageName: PKG,
      tableName: TABLE,
    });
  };
  const insert = (slug: string, email: string | null) =>
    db.query(
      `INSERT INTO ${TABLE} (id, slug, title, email) VALUES ('${crypto.randomUUID()}', '${slug}', 't', ${email === null ? 'NULL' : `'${email}'`})`,
    );
  const emails = async () =>
    (
      (await db.query(`SELECT slug, email FROM ${TABLE} ORDER BY slug`))
        .rows as Array<{ slug: string; email: unknown }>
    ).map((row) => [row.slug, row.email]);
  const insertWithoutEmail = (slug: string) =>
    db.query(
      `INSERT INTO ${TABLE} (id, slug, title) VALUES ('${crypto.randomUUID()}', '${slug}', 't')`,
    );

  it('stops instead of filling existing NULLs with the default, and names the ways to fill them', async () => {
    register('optional');
    expect((await migrate()).refused).toBe(false);
    await insert('p1', null);
    await insert('p2', 'a@b.c');

    register('required');
    const result = await migrate();

    expect(result).toMatchObject({ refused: true, applied: false });
    expect(result.stops.map((stop) => stop.kind)).toEqual([
      'column.required-nulls',
    ]);
    const [stop] = result.stops;
    expect(stop.reason).toBe('invents-data');
    expect(stop.message).toContain(`${TABLE}.email`);
    expect(stop.message).toContain(`--fill-required ${TABLE}.email`);
    expect(stop.message).toContain('backfill');
    expect(await emails()).toEqual([
      ['p1', null],
      ['p2', 'a@b.c'],
    ]);
    // Still nullable: nothing ran.
    await insert('p3', null);
  });

  it('fills the NULLs from the default when the column is named, then enforces NOT NULL', async () => {
    register('optional');
    expect((await migrate()).refused).toBe(false);
    await insert('p1', null);
    await insert('p2', 'a@b.c');

    register('required');
    const result = await migrate({
      fillRequiredFromDefault: [`${TABLE}.email`],
    });

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(result.notices).toEqual([]);
    expect(await emails()).toEqual([
      ['p1', ''],
      ['p2', 'a@b.c'],
    ]);
    await expect(insert('p3', null)).rejects.toThrow();
  });

  it('enforces NOT NULL without a flag when no row holds NULL', async () => {
    register('optional');
    expect((await migrate()).refused).toBe(false);
    await insert('p1', 'x@y.z');

    register('required');
    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(await emails()).toEqual([['p1', 'x@y.z']]);
    await expect(insert('p2', null)).rejects.toThrow();
  });

  it('says so when a named column has nothing to fill', async () => {
    register('optional');
    expect((await migrate()).refused).toBe(false);
    await insert('p1', 'x@y.z');

    register('required');
    const result = await migrate({
      fillRequiredFromDefault: [`${TABLE}.email`, `${TABLE}.nothing`],
    });

    expect(result.refused).toBe(false);
    expect(result.notices).toEqual([
      `Ignoring fillRequiredFromDefault ${TABLE}.email: no column of that name becomes required with NULLs to fill from a declared default (a field's own backfill, when it declares one, fills them instead).`,
      `Ignoring fillRequiredFromDefault ${TABLE}.nothing: no column of that name becomes required with NULLs to fill from a declared default (a field's own backfill, when it declares one, fills them instead).`,
    ]);
  });

  it('makes a removed required field nullable so inserts work, keeping its values', async () => {
    register('required-no-default');
    expect((await migrate()).refused).toBe(false);
    await insert('p1', 'kept@x.y');

    register('removed');
    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(result.relaxedColumns).toEqual([
      { table: TABLE, column: 'email', alteration: 'drop_not_null' },
    ]);
    await insertWithoutEmail('p2');
    expect(await emails()).toEqual([
      ['p1', 'kept@x.y'],
      ['p2', null],
    ]);
    // Settled: the next migrate has nothing to do.
    const again = await migrate();
    expect(again).toMatchObject({ refused: false, applied: false });
  });

  /** Two required fields with no default, or both removed. */
  const registerPair = (present: boolean) => {
    ObjectRegistry.clear();
    class RequiredPair extends SmrtObject {
      title = '';
      email = '';
      code = '';
    }
    field({ type: 'text' })(RequiredPair.prototype, 'title');
    if (present)
      for (const name of ['email', 'code'] as const)
        field({ type: 'text', required: true, default: null as never })(
          RequiredPair.prototype,
          name,
        );
    ObjectRegistry.register(RequiredPair, {
      packageName: PKG,
      tableName: 'required_pairs',
    });
  };

  it('lists every column it relaxes, also when one rebuild relaxes several', async () => {
    registerPair(true);
    expect((await migrate()).refused).toBe(false);
    registerPair(false);

    const result = await migrate();

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(
      result.relaxedColumns
        .map((item) => `${item.table}.${item.column}`)
        .sort(),
    ).toEqual(['required_pairs.code', 'required_pairs.email']);
  });

  it('says a fill request was not used when the field declares its own backfill', async () => {
    register('optional');
    expect((await migrate()).refused).toBe(false);
    await insert('p1', null);
    ObjectRegistry.clear();
    class RequiredProfile extends SmrtObject {
      title = '';
      email = '';
    }
    field({ type: 'text' })(RequiredProfile.prototype, 'title');
    field({
      type: 'text',
      required: true,
      default: '',
      backfill: "'from-backfill'",
    })(RequiredProfile.prototype, 'email');
    ObjectRegistry.register(RequiredProfile, {
      packageName: PKG,
      tableName: TABLE,
    });

    const result = await migrate({
      fillRequiredFromDefault: [`${TABLE}.email`],
    });

    expect(result).toMatchObject({ refused: false, applied: true });
    expect(await emails()).toEqual([['p1', 'from-backfill']]);
    expect(result.notices).toEqual([
      expect.stringContaining(
        `Ignoring fillRequiredFromDefault ${TABLE}.email`,
      ),
    ]);
  });
});

describe.each(
  engines,
)('an undeclared column the database fills or keys on %s (#5455)', (engine) => {
  const hint = engine === 'pglite' ? 'postgres' : engine;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  beforeEach(async () => {
    db =
      engine === 'pglite'
        ? await getTestDatabase({
            type: 'pglite',
            classes: [],
            includeSystemTables: false,
          })
        : ((await getDatabase({
            type: engine,
            url: ':memory:',
          })) as typeof db);
  });
  afterEach(async () => {
    await db.close?.();
  });
  const manifest = (table: string) => ({
    [table]: {
      tableName: table,
      columns: { id: { type: 'TEXT' as const, primaryKey: true } },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  });

  it('reports, and never relaxes, a primary-key column that is not declared', async () => {
    await db.query(
      'CREATE TABLE keyed_rows (id TEXT NOT NULL, part TEXT NOT NULL, PRIMARY KEY (id, part))',
    );
    const diff = await new SchemaComparer(db, { engineHint: hint }).compare(
      manifest('keyed_rows'),
    );
    const part = diff.changes.filter((change) => change.name === 'part');
    expect(part.map((change) => change.alteration)).not.toContain(
      'drop_not_null',
    );
    expect(part.map(classifySchemaChange)).toEqual(['column.orphan-not-null']);
  });

  it.runIf(hint === 'postgres')(
    'leaves an undeclared identity column alone: the database fills it',
    async () => {
      await db.query(
        'CREATE TABLE identity_rows (id TEXT PRIMARY KEY, seq INTEGER GENERATED ALWAYS AS IDENTITY)',
      );
      const diff = await new SchemaComparer(db, { engineHint: hint }).compare(
        manifest('identity_rows'),
      );
      const seq = diff.changes.filter((change) => change.name === 'seq');
      expect(seq.map(classifySchemaChange)).toEqual(['column.orphan']);
      await db.query("INSERT INTO identity_rows (id) VALUES ('a')");
    },
  );
});

/**
 * #4932: an app hardens a smrt object by overriding a field on a subclass.
 * End to end on SQLite, for an own-table parent and a shared-table parent:
 * the subclass is stricter, a save without the field is refused, and the
 * parent is unchanged. The own-table column is NOT NULL.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'own_docs_4932' })
class OwnDoc4932 extends SmrtObject {
  @field()
  title: string | null = null;
}

@smrt({ tableName: 'own_strict_docs_4932' })
class OwnStrictDoc4932 extends OwnDoc4932 {
  @field({ required: true })
  override title: string | null = null;
}

@smrt({ tableStrategy: 'sti', tableName: 'shared_docs_4932' })
class SharedDoc4932 extends SmrtObject {
  @field()
  title: string | null = null;
}

@smrt({ tableStrategy: 'sti', tableName: 'shared_docs_4932' })
class SharedStrictDoc4932 extends SharedDoc4932 {
  @field({ required: true })
  override title: string | null = null;
}

describe('#4932 hardening by a subclass override (SQLite)', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'OwnDoc4932',
        'OwnStrictDoc4932',
        'SharedDoc4932',
        'SharedStrictDoc4932',
      ],
    });
  });
  afterEach(async () => {
    await db.close?.();
  });

  it('own table: the stricter subclass column is NOT NULL, the parent column is not', async () => {
    const info = async (table: string) =>
      Object.fromEntries(
        (
          (await db.query(`PRAGMA table_info("${table}")`)).rows as Array<{
            name: string;
            notnull: number;
          }>
        ).map((c) => [c.name, c.notnull === 1]),
      );
    expect((await info('own_strict_docs_4932')).title).toBe(true);
    expect((await info('own_docs_4932')).title).toBe(false);
  });

  const make = async <T extends SmrtObject>(
    Ctor: new (options: Record<string, unknown>) => T,
    options: Record<string, unknown>,
  ): Promise<T> => (await new Ctor({ db, ...options }).initialize()) as T;

  it('own table: a save without the field is refused, the parent still saves', async () => {
    const strict = await make(OwnStrictDoc4932, { slug: 'a' });
    await expect(strict.save()).rejects.toMatchObject({
      code: 'VALIDATION_REQUIRED_FIELD',
      details: { fieldName: 'title' },
    });
    const parent = await make(OwnDoc4932, { slug: 'a' });
    await expect(parent.save()).resolves.toBe(parent);
  });

  it('own table: a save with the field works', async () => {
    const strict = await make(OwnStrictDoc4932, { slug: 'b', title: 'x' });
    await expect(strict.save()).resolves.toBe(strict);
  });

  it('shared table: a save without the field is refused, the parent still saves', async () => {
    const strict = await make(SharedStrictDoc4932, { slug: 'a' });
    await expect(strict.save()).rejects.toMatchObject({
      code: 'VALIDATION_REQUIRED_FIELD',
      details: { fieldName: 'title' },
    });
    const parent = await make(SharedDoc4932, { slug: 'a' });
    await expect(parent.save()).resolves.toBe(parent);
  });

  it('shared table: a save with the field works', async () => {
    const strict = await make(SharedStrictDoc4932, { slug: 'b', title: 'x' });
    await expect(strict.save()).resolves.toBe(strict);
  });
});

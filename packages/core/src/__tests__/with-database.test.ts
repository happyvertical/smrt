import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { SmrtClass } from '../class.js';
import { getTestDatabase } from '../testing/database.js';

describe('SmrtClass.withDatabase', () => {
  const databases: DatabaseInterface[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close?.()));
  });

  async function database(): Promise<DatabaseInterface> {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    databases.push(db);
    return db;
  }

  it('uses the bound database and restores the original after success', async () => {
    const root = await database();
    const transaction = await database();
    const instance = new SmrtClass({ db: root });
    await instance.initialize();

    const result = await instance.withDatabase(transaction, async (bound) => {
      expect(bound).toBe(instance);
      expect(bound.db).toBe(transaction);
      expect(bound.options.db).toBe(transaction);
      return 'bound-result';
    });

    expect(result).toBe('bound-result');
    expect(instance.db).toBe(root);
    expect(instance.options.db).toBe(root);
  });

  it('restores the original database when the callback throws', async () => {
    const root = await database();
    const transaction = await database();
    const instance = new SmrtClass({ db: root });
    await instance.initialize();
    const failure = new Error('transaction callback failed');

    await expect(
      instance.withDatabase(transaction, async (bound) => {
        expect(bound.db).toBe(transaction);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(instance.db).toBe(root);
    expect(instance.options.db).toBe(root);
  });
});

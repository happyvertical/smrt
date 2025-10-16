import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from './index';

async function checkPostgreSQLConnection(): Promise<boolean> {
  try {
    const testDb = await getDatabase({
      type: 'postgres',
      database: process.env.SQLOO_DATABASE || 'testdb',
      host: process.env.SQLOO_HOST || 'localhost',
      user: process.env.SQLOO_USER || 'postgres',
      password: process.env.SQLOO_PASSWORD || 'postgres',
      port: Number(process.env.SQLOO_PORT) || 5432,
    });

    // Try a simple query to test the connection
    await testDb.execute`SELECT 1`;
    await testDb.client.end();
    return true;
  } catch (_error) {
    return false;
  }
}

describe('postgres tests', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let postgresAvailable = false;

  beforeEach(async () => {
    // Check if PostgreSQL is available
    postgresAvailable = await checkPostgreSQLConnection();
    if (!postgresAvailable) {
      console.log('PostgreSQL not available, skipping test');
      return;
    }

    db = await getDatabase({
      type: 'postgres',
      database: process.env.SQLOO_DATABASE || 'testdb',
      host: process.env.SQLOO_HOST || 'localhost',
      user: process.env.SQLOO_USER || 'postgres',
      password: process.env.SQLOO_PASSWORD || 'postgres',
      port: Number(process.env.SQLOO_PORT) || 5432,
    });

    await db.execute`
      create extension if not exists "uuid-ossp";
      drop table if exists contents;
      create table contents (
        id uuid primary key not null default (uuid_generate_v4()),
        title text, 
        body text
      )
    `;
  });

  afterEach(async () => {
    if (!postgresAvailable || !db) return;

    await db.execute`drop table if exists contents`;
    await db.client.end();
  });

  it('should be able to perform a statement', async () => {
    if (!postgresAvailable) return;

    const result = await db.many`
      select * from contents
    `;
    expect(result).toEqual(expect.arrayContaining([]));
  });

  it('should be able to insert data', async () => {
    if (!postgresAvailable) return;

    const inserted = await db.insert('contents', {
      title: 'hello',
      body: 'world',
    });
    expect(inserted).toBeDefined();
    expect(inserted.affected).toBe(1);
  });

  it('should be able to insert multiple rows at a time', async () => {
    if (!postgresAvailable) return;

    const inserted = await db.insert('contents', [
      {
        title: 'hello',
        body: 'world',
      },
      {
        title: 'hi',
        body: 'universe',
      },
    ]);
    expect(inserted.affected).toBe(2);
  });

  it('should be able to query data with a condition', async () => {
    if (!postgresAvailable) return;

    await db.insert('contents', { title: 'hello', body: 'world' });
    const result = await db.many`
      select * from contents where title = ${'hello'}
    `;
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        title: 'hello',
        body: 'world',
      }),
    );
  });

  it('should be able to get a single row', async () => {
    if (!postgresAvailable) return;

    await db.insert('contents', { title: 'hello', body: 'world' });
    const result = await db.single`
      select * from contents where title = ${'hello'}
    `;
    expect(result).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        title: 'hello',
        body: 'world',
      }),
    );
  });

  it('should be able to update a row', async () => {
    if (!postgresAvailable) return;

    const id = randomUUID();
    const inserted = await db.insert('contents', {
      id,
      title: 'hello',
      body: 'world',
    });
    expect(inserted.affected).toBe(1);
    const updated = await db.update(
      'contents',
      { id },
      { title: 'hi', body: 'universe' },
    );
    expect(updated.affected).toBe(1);
    const result = await db.oO`
      select * from contents where id = ${id}
    `;
    expect(result?.id).toEqual(id);
    expect(result?.title).toEqual('hi');
    expect(result?.body).toEqual('universe');
  });

  it('should support transactions with commit', async () => {
    if (!postgresAvailable || !db || !db.transaction) return;

    const id = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert('contents', {
        id,
        title: 'Transaction Test',
        body: 'This should be committed',
      });

      // Verify within transaction
      const result = await tx.get('contents', { id });
      expect(result).toBeTruthy();
      expect(result?.title).toBe('Transaction Test');
    });

    // Verify after transaction commits
    const result = await db.get('contents', { id });
    expect(result).toBeTruthy();
    expect(result?.title).toBe('Transaction Test');
  });

  it('should support transactions with rollback on error', async () => {
    if (!postgresAvailable || !db || !db.transaction) return;

    const id = randomUUID();

    try {
      await db.transaction(async (tx) => {
        await tx.insert('contents', {
          id,
          title: 'Rollback Test',
          body: 'This should be rolled back',
        });

        // Verify within transaction
        const result = await tx.get('contents', { id });
        expect(result).toBeTruthy();

        // Force an error
        throw new Error('Intentional rollback');
      });

      // Should not reach here
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toBe('Intentional rollback');
    }

    // Verify record was rolled back
    const result = await db.get('contents', { id });
    expect(result).toBeNull();
  });
});

import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { dropExecutionDatabase } from './test-support/postgres-cleanup.js';

const name = 'exec_11111111111111111111111111111111';
describe('ordinary-role fixture cleanup boundary', () => {
  it.each([
    'exec',
    'ing',
    'ext',
    'sources',
  ])('accepts only the owned %s fixture namespace without FORCE', async (prefix) => {
    const statements: string[] = [];
    const query: DatabaseInterface['query'] = async (sql) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    };
    const database = `${prefix}_${'1'.repeat(32)}`;
    await dropExecutionDatabase({ query }, database);
    await dropExecutionDatabase({ query }, database);
    expect(statements).toEqual([
      `DROP DATABASE IF EXISTS ${database}`,
      `DROP DATABASE IF EXISTS ${database}`,
    ]);
  });
  it.each([
    'postgres',
    'other_' + '1'.repeat(32),
    'ing_' + '1'.repeat(31),
    'ext_' + '1'.repeat(33),
    'sources_' + 'A'.repeat(32),
    'exec_' + '1'.repeat(32) + '; SELECT 1',
    'exec_"; DROP DATABASE postgres; --',
  ])('rejects invalid name %s before SQL', async (database) => {
    let calls = 0;
    const query: DatabaseInterface['query'] = async () => {
      calls++;
      return { rows: [], rowCount: 0 };
    };
    await expect(dropExecutionDatabase({ query }, database)).rejects.toThrow(
      'Invalid fixture database',
    );
    expect(calls).toBe(0);
  });
  it.each([
    '08006',
    'XX000',
    undefined,
  ])('does not retry unclassified failure %s', async (code) => {
    let calls = 0;
    const error = { code };
    const query: DatabaseInterface['query'] = async () => {
      calls++;
      throw error;
    };
    await expect(dropExecutionDatabase({ query }, name)).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it('retries only a known database-in-use SQLSTATE', async () => {
    let calls = 0;
    const query: DatabaseInterface['query'] = async () => {
      calls++;
      if (calls === 1) throw new Error('wrapped', { cause: { code: '55006' } });
      return { rows: [], rowCount: 0 };
    };
    await dropExecutionDatabase({ query }, name);
    expect(calls).toBe(2);
  });
  it('propagates permission errors without retrying or pretending cleanup succeeded', async () => {
    let calls = 0;
    const error = new Error('permission denied', { cause: { code: '42501' } });
    const query: DatabaseInterface['query'] = async () => {
      calls++;
      throw error;
    };
    await expect(dropExecutionDatabase({ query }, name)).rejects.toBe(error);
    expect(calls).toBe(1);
  });
  it('fails at its deadline instead of ignoring a persistent connection leak', async () => {
    const error = new Error('database in use', { cause: { code: '55006' } });
    const query: DatabaseInterface['query'] = async () => {
      throw error;
    };
    await expect(dropExecutionDatabase({ query }, name, 0)).rejects.toBe(error);
  });
});

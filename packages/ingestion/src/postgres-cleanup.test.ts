import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { dropExecutionDatabase } from './test-support/postgres-cleanup.js';

const name = 'exec_11111111111111111111111111111111';
describe('ordinary-role fixture cleanup boundary', () => {
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

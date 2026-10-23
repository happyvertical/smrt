import { describe, expect, it } from 'vitest';
import {
  assertParticipationWrite,
  withParticipationWrite,
} from './write-authority.js';

describe('executor-bound participation authority', () => {
  it('authorizes only the operation executor across awaits and revokes it on completion', async () => {
    const transaction = {};
    const rootAdapter = {};
    const concurrentTransaction = {};
    await withParticipationWrite(transaction, async () => {
      expect(() => assertParticipationWrite(transaction)).not.toThrow();
      await Promise.resolve();
      expect(() => assertParticipationWrite(rootAdapter)).toThrow(
        'service write authority',
      );
      expect(() => assertParticipationWrite(concurrentTransaction)).toThrow(
        'service write authority',
      );
      expect(() => assertParticipationWrite(transaction)).not.toThrow();
    });
    expect(() => assertParticipationWrite(transaction)).toThrow(
      'service write authority',
    );
  });
  it('revokes a failed operation and retains only an enclosing scope on the same executor', async () => {
    const transaction = {};
    await withParticipationWrite(transaction, async () => {
      await expect(
        withParticipationWrite(transaction, async () => {
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(() => assertParticipationWrite(transaction)).not.toThrow();
    });
    expect(() => assertParticipationWrite(transaction)).toThrow(
      'service write authority',
    );
  });
});

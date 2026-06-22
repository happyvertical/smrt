/**
 * Regression tests for the recall() / recallAll() JSON-parse guard (#1378).
 *
 * A single corrupted `_smrt_contexts.value` row must not throw an uncaught
 * SyntaxError out of SmrtObject.recall()/recallAll(): recall() treats it as a
 * miss (returns null / continues the ancestor fallback) and recallAll() skips
 * it while still returning the rest of the scope.
 *
 * Real in-memory SQLite (systemDb === the object's db) — no DB mocking.
 */

import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';

// Module-level so the AST scanner registers it during test manifest generation.
class RecallCorruptionObject extends SmrtObject {
  value: string = '';
}

describe('SmrtObject recall guards corrupted _smrt_contexts rows (#1378)', () => {
  let obj: RecallCorruptionObject;
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    // _skipLoad: the object's own table is never migrated here; recall/remember
    // only touch the _smrt_contexts system table (created during initialize()).
    obj = new RecallCorruptionObject({
      db,
      id: 'owner-1',
      value: 'v',
      _skipLoad: true,
    });
    await obj.initialize();
  });

  it('recall() returns null instead of throwing on a corrupted value', async () => {
    await obj.remember({ scope: 'parser', key: 'k1', value: { ok: true } });
    await db.query(
      `UPDATE _smrt_contexts SET value = $1 WHERE scope = $2 AND key = $3`,
      '{not valid json',
      'parser',
      'k1',
    );

    let result: unknown;
    await expect(
      (async () => {
        result = await obj.recall({ scope: 'parser', key: 'k1' });
      })(),
    ).resolves.toBeUndefined();
    expect(result).toBeNull();
  });

  it('recall() still falls back to an ancestor scope when the child is corrupted', async () => {
    await obj.remember({
      scope: 'parser',
      key: 'k1',
      value: { from: 'parent' },
    });
    await obj.remember({
      scope: 'parser/child',
      key: 'k1',
      value: { from: 'child' },
    });
    // Corrupt only the child-scope row.
    await db.query(
      `UPDATE _smrt_contexts SET value = $1 WHERE scope = $2 AND key = $3`,
      'not-json',
      'parser/child',
      'k1',
    );

    const result = await obj.recall({
      scope: 'parser/child',
      key: 'k1',
      includeAncestors: true,
    });
    expect(result).toEqual({ from: 'parent' });
  });

  it('recallAll() skips a corrupted row and returns the rest of the scope', async () => {
    await obj.remember({ scope: 's', key: 'good', value: 1 });
    await obj.remember({ scope: 's', key: 'bad', value: 2 });
    await db.query(
      `UPDATE _smrt_contexts SET value = $1 WHERE scope = $2 AND key = $3`,
      '<<<corrupt>>>',
      's',
      'bad',
    );

    const all = await obj.recallAll({ scope: 's' });
    expect(all.get('good')).toBe(1);
    expect(all.has('bad')).toBe(false);
  });
});

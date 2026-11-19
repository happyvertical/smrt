/**
 * #5143: a same-named class resolves its parent from the nearest same-named
 * constructor above it, whichever other registrations came first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import { snapshotObjectRegistryState } from '../../test-utils';

const A = '@fixture/fo5143-a';
const B = '@fixture/fo5143-b';
const C = '@fixture/fo5143-c';

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

describe('a replacement never skips its unregistered direct parent', () => {
  it('refuses the leaf of a three-level family while its middle is unregistered, then accepts it parent-first', () => {
    const Base = class Scene extends SmrtObject {
      title = '';
    };
    const Middle = class Scene extends Base {
      mood = '';
    };
    const Leaf = class Scene extends Middle {
      tone = '';
    };
    smrt({ packageName: A, mcp: { include: ['list'] } })(Base);
    expect(() => smrt({ packageName: C, replaceParent: true })(Leaf)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_PARENT_UNREGISTERED',
      }),
    );
    expect(ObjectRegistry.getClassByConstructor(Leaf)).toBeUndefined();

    smrt({ packageName: B, replaceParent: true, mcp: false })(Middle);
    smrt({ packageName: C, replaceParent: true })(Leaf);
    const leaf = ObjectRegistry.getClassByConstructor(Leaf);
    expect(leaf).toBeDefined();
    // The middle's choice (no MCP tools), not the base's, reaches the leaf.
    expect(leaf?.config.mcp).toBe(false);
  });
});

describe('a subtype of a replaced parent still gets the table check', () => {
  it('refuses an explicit different table after a sibling replaced the single-table parent', () => {
    const Base = class Scene extends SmrtObject {
      title = '';
    };
    const Replacement = class Scene extends Base {
      mood = '';
    };
    const Sub = class Scene extends Base {
      tone = '';
    };
    smrt({
      packageName: A,
      tableStrategy: 'sti',
      tableName: 'scenes',
    })(Base);
    smrt({ packageName: B, replaceParent: true })(Replacement);
    expect(() =>
      smrt({ packageName: C, replaceParent: false, tableName: 'other_scenes' })(
        Sub,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_TABLE_MISMATCH',
      }),
    );
    expect(ObjectRegistry.getClassByConstructor(Sub)).toBeUndefined();
  });

  it('accepts the subtype on the parent table after the sibling replacement', () => {
    const Base = class Scene extends SmrtObject {
      title = '';
    };
    const Replacement = class Scene extends Base {
      mood = '';
    };
    const Sub = class Scene extends Base {
      tone = '';
    };
    smrt({ packageName: A, tableStrategy: 'sti', tableName: 'scenes' })(Base);
    smrt({ packageName: B, replaceParent: true })(Replacement);
    smrt({ packageName: C, replaceParent: false })(Sub);
    const sub = ObjectRegistry.getClassByConstructor(Sub);
    expect(sub?.schema?.tableName).toBe('scenes');
  });
});

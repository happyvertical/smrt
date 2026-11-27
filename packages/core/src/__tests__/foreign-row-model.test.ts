import { describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { foreignRowModel } from '../request-input.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

describe('foreignRowModel (#5195)', () => {
  it('names a subtype row read through its base, nothing for the base row, and null for an unresolvable row', () => {
    const restore = snapshotObjectRegistryState();
    try {
      class FrmBase extends SmrtObject {}
      field({ type: 'text' })(FrmBase.prototype, 'title');
      smrt({ packageName: '@test/frm', tableStrategy: 'sti' } as never)(
        FrmBase,
      );
      class FrmSub extends FrmBase {}
      smrt({ packageName: '@test/frm' } as never)(FrmSub);
      const base = '@test/frm:FrmBase';
      const sub = '@test/frm:FrmSub';
      expect(ObjectRegistry.getClass(base)).toBeDefined();
      expect(foreignRowModel(Object.create(FrmSub.prototype), base)).toBe(sub);
      expect(foreignRowModel(Object.create(FrmBase.prototype), base)).toBe(
        undefined,
      );
      // A row whose class is not registered cannot be decided: refuse.
      expect(foreignRowModel({}, base)).toBeNull();
      expect(foreignRowModel(new (class Stray {})(), base)).toBeNull();
    } finally {
      restore();
    }
  });
});

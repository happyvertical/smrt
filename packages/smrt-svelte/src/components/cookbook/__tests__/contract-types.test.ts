import { describe, expect, it } from 'vitest';
import type { OverviewOverride } from '../../overview/types.js';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import {
  layoutFromContract,
  layoutIdentical,
  layoutToContract,
  overrideFromContract,
  overrideIdentical,
  overrideToContract,
  slotsIdentical,
} from './contract-types.js';

// The identity itself is asserted by `contract-types.ts` at typecheck time;
// this runs the conversions so the file stays imported and exercised.
describe('cookbook contract types (#3748)', () => {
  it('CookbookLayout is ShellLayout, both ways', () => {
    expect([layoutIdentical, slotsIdentical]).toEqual([true, true]);
    const layout: ShellLayout = {
      version: 1,
      hidden: ['item:a:B'],
      panels: { left: { visible: false } },
      placements: { 'slot:header.end': 'footer.end' },
    };
    expect(layoutFromContract(layoutToContract(layout))).toEqual(layout);
  });

  it('CookbookOverviewOverride is OverviewOverride, both ways', () => {
    expect(overrideIdentical).toBe(true);
    const override: OverviewOverride = {
      version: 1,
      order: ['a'],
      added: [{ id: 'w1', type: 'note', span: 2, options: { body: 'hi' } }],
      changed: { a: { span: 3 } },
    };
    expect(overrideFromContract(overrideToContract(override))).toEqual(
      override,
    );
  });
});

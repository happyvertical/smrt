import { describe, expect, it } from 'vitest';
import {
  resolveSlot,
  SHELL_SLOTS,
  slotFallbackChain,
} from '../../workspace/admin-shell/slots.js';

describe('shell slot fallback', () => {
  it('stays put when its region is visible', () => {
    for (const slot of SHELL_SLOTS) {
      expect(resolveSlot(slot, () => true)).toBe(slot);
    }
  });

  it('follows the documented chain', () => {
    expect(slotFallbackChain('header.end')).toEqual([
      'leftSidebar.header',
      'rightSidebar.header',
      'footer.end',
    ]);
    expect(resolveSlot('leftSidebar.footer', (r) => r === 'header')).toBe(
      'header.start',
    );
    expect(resolveSlot('footer.center', (r) => r === 'rightSidebar')).toBe(
      'rightSidebar.footer',
    );
    expect(resolveSlot('header.start', () => false)).toBeNull();
  });
});

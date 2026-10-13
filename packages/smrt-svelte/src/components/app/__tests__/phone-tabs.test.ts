import { describe, expect, it } from 'vitest';
import {
  isTabCurrent,
  phoneTabNavEntries,
  planPhoneTabs,
  resolvePhoneTabBar,
} from '../phone-tabs.js';

const entries = Array.from({ length: 6 }, (_, i) => ({
  id: `n${i}`,
  label: `N${i}`,
  href: `/n${i}`,
}));

describe('phone tab selection', () => {
  it('is off unless asked for and defaults to four items', () => {
    expect(resolvePhoneTabBar(undefined)).toBeNull();
    expect(resolvePhoneTabBar(false)).toBeNull();
    expect(resolvePhoneTabBar(true)).toEqual({ items: 4 });
    expect(resolvePhoneTabBar({})).toEqual({ items: 4 });
    expect(resolvePhoneTabBar({ items: 3 })).toEqual({ items: 3 });
  });

  it('takes N navigation items and adds More only when navigation overflows', () => {
    const plan = planPhoneTabs(entries, 4, false);
    expect(plan.nav.map((e) => e.id)).toEqual(['n0', 'n1', 'n2', 'n3']);
    expect(plan.more).toBe(true);
    expect(planPhoneTabs(entries.slice(0, 4), 4, false).more).toBe(false);
  });

  it('gives the dock tab one of the places', () => {
    const plan = planPhoneTabs(entries, 4, true);
    expect(plan.nav).toHaveLength(3);
    expect(plan.more).toBe(true);
    expect(planPhoneTabs(entries.slice(0, 3), 4, true).more).toBe(false);
  });

  it('flattens groups in items mode and lists one entry per group in sections mode', () => {
    const groups = [
      { heading: 'Floor', href: '/floor', items: [{ href: '/a', label: 'A' }] },
      { heading: 'Office', items: [{ href: '/b', label: 'B' }] },
    ];
    const flat = [{ href: '/home', label: 'Home' }];
    expect(
      phoneTabNavEntries(flat, groups, 'items').map((e) => e.href),
    ).toEqual(['/home', '/a', '/b']);
    expect(
      phoneTabNavEntries(flat, groups, 'sections').map((e) => e.href),
    ).toEqual(['/home', '/floor', '/b']);
  });

  it('marks a tab current on its page or a child page', () => {
    expect(isTabCurrent('/a', '/a')).toBe(true);
    expect(isTabCurrent('/a', '/a/b')).toBe(true);
    expect(isTabCurrent('/a', '/ab')).toBe(false);
  });
});

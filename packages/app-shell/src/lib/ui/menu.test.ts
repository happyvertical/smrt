import { describe, expect, it } from 'vitest';
import { buildMenu, userMenuItems } from './menu.ts';
import type { ModelInfo } from './types.ts';

const model = (label: string) => ({ label }) as ModelInfo;

describe('menu', () => {
  it('has home and a model entry each, nothing else', () => {
    const items = buildMenu({
      models: { Chore: model('Chores'), 'A B': model('') },
    });
    expect(items.map((i) => i.label)).toEqual(['Home', 'Chores', 'A B']);
    expect(items[2].href).toBe('/m/A%20B');
  });

  it('keeps Approvals and History out of the side menu', () => {
    const ids = buildMenu({ models: {} }).map((i) => i.id);
    expect(ids).toEqual(['home']);
    expect(buildMenu(null).map((i) => i.id)).toEqual(['home']);
  });
});

describe('user menu', () => {
  it('lists Approvals then History', () => {
    expect(userMenuItems(0).map((i) => [i.label, i.href])).toEqual([
      ['Approvals', '/approvals'],
      ['History', '/history'],
    ]);
  });

  it('badges approvals only when something is pending', () => {
    expect(userMenuItems(0)[0].badge).toBeNull();
    expect(userMenuItems(-2)[0].badge).toBeNull();
    const some = userMenuItems(3)[0];
    expect(some.badge).toBe(3);
    expect(some.badgeLabel).toBe('3 waiting for your decision');
    expect(userMenuItems(3)[1].badge).toBeNull();
  });
});

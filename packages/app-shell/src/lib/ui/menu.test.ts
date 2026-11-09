import { describe, expect, it } from 'vitest';
import { buildMenu } from './menu.ts';
import type { ModelInfo } from './types.ts';

const model = (label: string) => ({ label }) as ModelInfo;

describe('menu', () => {
  it('has home, a model entry each, approvals and history', () => {
    const items = buildMenu(
      { models: { Chore: model('Chores'), 'A B': model('') } },
      0,
    );
    expect(items.map((i) => i.label)).toEqual([
      'Home',
      'Chores',
      'A B',
      'Approvals',
      'History',
    ]);
    expect(items[2].href).toBe('/m/A%20B');
  });

  it('badges approvals only when something is pending', () => {
    const none = buildMenu({ models: {} }, 0).find((i) => i.id === 'approvals');
    const some = buildMenu({ models: {} }, 3).find((i) => i.id === 'approvals');
    expect(none?.badge).toBeNull();
    expect(some?.badge).toBe(3);
    expect(some?.attention).toBe(true);
  });

  it('still has the fixed entries when signed out', () => {
    expect(buildMenu(null).length).toBe(3);
  });
});

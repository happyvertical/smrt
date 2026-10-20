import { describe, expect, it } from 'vitest';
import { createShellTargets } from '../admin-shell/targets.js';
import { shellTargetAction } from '../index.js';

describe('scoped semantic shell targets', () => {
  it('registers actual semantic refs, prefers visible nodes and retires exact nodes', () => {
    const registry = createShellTargets();
    const hidden = document.createElement('div');
    hidden.hidden = true;
    const first = document.createElement('a');
    hidden.append(first);
    const visible = document.createElement('a');
    document.body.append(hidden, visible);
    const stop1 = registry.register('section:sales', first);
    const stop2 = registry.register('section:sales', visible);
    expect(registry.get('section:sales')).toBe(visible);
    expect(visible.dataset.smrtTarget).toBe('section:sales');
    stop2();
    expect(registry.get('section:sales')).toBeUndefined();
    hidden.hidden = false;
    expect(registry.get('section:sales')).toBe(first);
    stop1();
    expect(registry.get('section:sales')).toBeUndefined();
    hidden.remove();
    visible.remove();
  });
});

it('exports the action used by consumer controls and retires its node', () => {
  const registry = createShellTargets();
  const node = document.createElement('button');
  document.body.append(node);
  const registration = shellTargetAction(registry)(node, 'item:consumer');
  expect(registry.get('item:consumer')).toBe(node);
  registration.destroy();
  expect(registry.get('item:consumer')).toBeUndefined();
  node.remove();
});

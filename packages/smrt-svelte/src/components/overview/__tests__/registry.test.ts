import { describe, expect, it } from 'vitest';
import { createWidgetRegistry } from '../registry.js';

describe('WidgetRegistry', () => {
  const def = { type: 'metric', title: 'Metric', options: [] };

  it('registers, fills defaults and disposes', () => {
    const registry = createWidgetRegistry();
    const dispose = registry.register(def);
    expect(registry.get('metric')).toMatchObject({
      version: 1,
      defaultSpan: 1,
      minSpan: 1,
      maxSpan: 4,
    });
    dispose();
    expect(registry.has('metric')).toBe(false);
  });

  it('refuses duplicates unless replacing; a stale disposer is a no-op', () => {
    const registry = createWidgetRegistry();
    const first = registry.register(def);
    expect(() => registry.register(def)).toThrow(/already registered/);
    registry.register({ ...def, title: 'Two' }, { replace: true });
    first();
    expect(registry.get('metric')?.title).toBe('Two');
  });

  it('rejects malformed definitions', () => {
    const registry = createWidgetRegistry();
    expect(() => registry.register({ ...def, type: 'Bad Type' })).toThrow();
    expect(() => registry.register({ ...def, version: 0 })).toThrow();
    expect(() =>
      registry.register({ ...def, minSpan: 3, maxSpan: 2 }),
    ).toThrow();
    expect(() => registry.register({ ...def, maxSpan: 5 })).toThrow();
    expect(() =>
      registry.register({ ...def, allowedIn: ['bad id'] }),
    ).toThrow();
  });

  it('clamps the default span into the range', () => {
    const registry = createWidgetRegistry();
    registry.register({ ...def, defaultSpan: 4, maxSpan: 2 });
    expect(registry.get('metric')?.defaultSpan).toBe(2);
  });
});

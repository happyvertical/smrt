import { afterEach, describe, expect, it } from 'vitest';
import {
  getClassConfigResolvers,
  getConfigResolver,
  isLazyConfigSentinel,
  listConfigResolvers,
  registerConfigResolver,
  resetConfigResolvers,
  resolveLazyConfig,
  unregisterConfigResolver,
} from './lazy-config';

describe('lazy-config', () => {
  afterEach(() => {
    resetConfigResolvers();
  });

  describe('isLazyConfigSentinel', () => {
    it('recognises {$env} sentinels', () => {
      expect(isLazyConfigSentinel({ $env: 'foo' })).toBe(true);
    });

    it('recognises {$resolver} sentinels', () => {
      expect(isLazyConfigSentinel({ $resolver: 'foo' })).toBe(true);
    });

    it('rejects sentinels with extra keys (so user data is not mistaken)', () => {
      expect(isLazyConfigSentinel({ $env: 'foo', extra: 1 })).toBe(false);
    });

    it('rejects sentinels with empty resolver name', () => {
      expect(isLazyConfigSentinel({ $env: '' })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isLazyConfigSentinel(null)).toBe(false);
      expect(isLazyConfigSentinel('not a sentinel')).toBe(false);
      expect(isLazyConfigSentinel(42)).toBe(false);
      expect(isLazyConfigSentinel([{ $env: 'foo' }])).toBe(false);
    });
  });

  describe('global resolver registry', () => {
    it('registers, retrieves, lists, and unregisters resolvers', () => {
      const resolver = () => 'value';
      registerConfigResolver('a', resolver);
      registerConfigResolver('b', () => 'other');

      expect(getConfigResolver('a')).toBe(resolver);
      expect(listConfigResolvers()).toEqual(['a', 'b']);

      expect(unregisterConfigResolver('a')).toBe(true);
      expect(getConfigResolver('a')).toBeUndefined();
      expect(unregisterConfigResolver('a')).toBe(false);
    });

    it('rejects invalid registrations', () => {
      expect(() => registerConfigResolver('', () => null)).toThrow(
        'non-empty string',
      );
      expect(() =>
        registerConfigResolver('foo', undefined as unknown as () => unknown),
      ).toThrow('must be a function');
    });

    it('replaces a resolver when registered with the same name', () => {
      registerConfigResolver('foo', () => 1);
      registerConfigResolver('foo', () => 2);

      const resolver = getConfigResolver('foo');
      expect(resolver?.()).toBe(2);
    });
  });

  describe('resolveLazyConfig — sentinel resolution', () => {
    it('replaces top-level sentinels with the resolver value', async () => {
      registerConfigResolver('storage', () => ({ bucket: 'live-bucket' }));

      const resolved = await resolveLazyConfig({
        assetStorage: { $env: 'storage' },
        unrelated: 'untouched',
      });

      expect(resolved).toEqual({
        assetStorage: { bucket: 'live-bucket' },
        unrelated: 'untouched',
      });
    });

    it('resolves nested sentinels inside objects and arrays', async () => {
      registerConfigResolver('apiKey', async () => 'live-key');

      const resolved = await resolveLazyConfig({
        deeply: { nested: { key: { $env: 'apiKey' } } },
        list: [{ $env: 'apiKey' }, 'literal'],
      });

      expect(resolved).toEqual({
        deeply: { nested: { key: 'live-key' } },
        list: ['live-key', 'literal'],
      });
    });

    it('does not mutate the input object', async () => {
      registerConfigResolver('foo', () => 'bar');

      const input = { value: { $env: 'foo' } };
      const resolved = await resolveLazyConfig(input);

      expect(resolved).not.toBe(input);
      expect(input.value).toEqual({ $env: 'foo' });
      expect(resolved.value).toBe('bar');
    });

    it('leaves sentinels in place when resolver is missing (default onError)', async () => {
      const resolved = await resolveLazyConfig({
        value: { $env: 'missing' },
      });

      expect(resolved).toEqual({ value: { $env: 'missing' } });
    });

    it('omits sentinels with onError: "omit"', async () => {
      const resolved = await resolveLazyConfig(
        { keep: 1, drop: { $env: 'missing' } },
        { onError: 'omit' },
      );

      expect(resolved).toEqual({ keep: 1 });
    });

    it('throws on missing resolver with onError: "throw"', async () => {
      await expect(
        resolveLazyConfig({ value: { $env: 'missing' } }, { onError: 'throw' }),
      ).rejects.toThrow('unknown resolver "missing"');
    });

    it('falls back to persisted value when resolver throws (default)', async () => {
      registerConfigResolver('flaky', () => {
        throw new Error('boom');
      });

      const resolved = await resolveLazyConfig({
        value: { $env: 'flaky' },
      });

      expect(resolved).toEqual({ value: { $env: 'flaky' } });
    });

    it('rethrows resolver errors with onError: "throw"', async () => {
      registerConfigResolver('flaky', () => {
        throw new Error('boom');
      });

      await expect(
        resolveLazyConfig({ value: { $env: 'flaky' } }, { onError: 'throw' }),
      ).rejects.toThrow('boom');
    });

    it('accepts a per-call resolvers map (Record or Map)', async () => {
      const resolved = await resolveLazyConfig(
        { value: { $env: 'foo' } },
        { resolvers: { foo: () => 'A' } },
      );
      expect(resolved.value).toBe('A');

      const map = new Map<string, () => unknown>([['foo', () => 'B']]);
      const resolved2 = await resolveLazyConfig(
        { value: { $env: 'foo' } },
        { resolvers: map },
      );
      expect(resolved2.value).toBe('B');
    });

    it('handles cyclic structures without infinite recursion', async () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;

      const resolved = await resolveLazyConfig(cyclic);
      expect(resolved.a).toBe(1);
      // Cycle is preserved internally: `resolved.self` points back at the
      // inner sentinel-resolved tree (not at the original `cyclic` input).
      // We verify by walking one step deeper — `resolved.self.self` should
      // be the same node as `resolved.self`, proving no aliasing leak.
      const inner = resolved.self as Record<string, unknown>;
      expect(inner.a).toBe(1);
      expect(inner.self).toBe(inner);
      // And the original input is untouched.
      expect(cyclic.self).toBe(cyclic);
    });

    it('preserves DAG structure: shared sub-objects produce shared clones with sentinels resolved', async () => {
      registerConfigResolver('apiKey', () => 'live-key');

      const shared: Record<string, unknown> = {
        nested: { key: { $env: 'apiKey' } },
      };
      const input = { left: shared, right: shared };

      const resolved = await resolveLazyConfig(input);

      // Both branches resolved the sentinel — the bug we'd guard against
      // is one branch keeping `{ $env: 'apiKey' }` because traversal
      // bailed on revisit.
      const left = resolved.left as Record<string, any>;
      const right = resolved.right as Record<string, any>;
      expect(left.nested.key).toBe('live-key');
      expect(right.nested.key).toBe('live-key');

      // Same shared input → same shared clone in the output (DAG fidelity).
      expect(left).toBe(right);

      // And the input is not mutated: original sentinel is intact.
      expect((shared.nested as any).key).toEqual({ $env: 'apiKey' });
    });

    it('caps recursion at MAX_DEPTH to prevent stack overflow from buggy persisted configs', async () => {
      // Build a chain 100 levels deep — beyond the depth cap.
      const root: Record<string, unknown> = {};
      let current = root;
      for (let i = 0; i < 100; i++) {
        const next: Record<string, unknown> = {};
        current.deeper = next;
        current = next;
      }
      // Should not throw or stack-overflow; deep tail is left as-is.
      const resolved = await resolveLazyConfig(root);
      expect(resolved).toBeTypeOf('object');
    });
  });

  describe('resolveLazyConfig — class resolvers', () => {
    it('overlays class resolvers on top of persisted config', async () => {
      const resolved = await resolveLazyConfig(
        { foo: 'persisted-foo', bar: 'persisted-bar' },
        { classResolvers: { foo: () => 'live-foo' } },
      );

      expect(resolved).toEqual({
        foo: 'live-foo',
        bar: 'persisted-bar',
      });
    });

    it('preserves persisted value when class resolver returns undefined', async () => {
      const resolved = await resolveLazyConfig(
        { foo: 'persisted' },
        { classResolvers: { foo: () => undefined } },
      );
      expect(resolved.foo).toBe('persisted');
    });

    it('preserves persisted value when class resolver returns null', async () => {
      // Real-world resolvers often look like `() => process.env.X ?? null`.
      // Treating `null` as "no overlay" prevents that pattern from silently
      // clobbering a snapshotted value when the env var is unset.
      const resolved = await resolveLazyConfig(
        { foo: 'persisted' },
        { classResolvers: { foo: () => null } },
      );
      expect(resolved.foo).toBe('persisted');
    });

    it('overlays falsy-but-real values from class resolvers (0, "", false)', async () => {
      // null/undefined are sentinels for "no overlay"; other falsy values
      // are legitimate config values and must overlay normally.
      const resolved = await resolveLazyConfig(
        { count: 99, label: 'old', flag: true },
        {
          classResolvers: {
            count: () => 0,
            label: () => '',
            flag: () => false,
          },
        },
      );
      expect(resolved).toEqual({ count: 0, label: '', flag: false });
    });

    it('preserves persisted value when class resolver throws (default)', async () => {
      const resolved = await resolveLazyConfig(
        { foo: 'persisted' },
        {
          classResolvers: {
            foo: () => {
              throw new Error('boom');
            },
          },
        },
      );
      expect(resolved.foo).toBe('persisted');
    });

    it('layers class resolvers after sentinel resolution', async () => {
      registerConfigResolver('shared', () => 'shared-live');

      const resolved = await resolveLazyConfig(
        {
          shared: { $env: 'shared' },
          extra: 'persisted-extra',
        },
        { classResolvers: { extra: () => 'class-overlay' } },
      );

      expect(resolved).toEqual({
        shared: 'shared-live',
        extra: 'class-overlay',
      });
    });
  });

  describe('getClassConfigResolvers', () => {
    it('returns resolvers declared on the class', () => {
      class Foo {
        static configResolvers = { a: () => 1 };
      }
      const resolvers = getClassConfigResolvers(Foo);
      expect(resolvers?.a?.()).toBe(1);
    });

    it('walks the prototype chain so subclasses inherit parent resolvers', () => {
      class Parent {
        static configResolvers = { a: () => 'parent-a' };
      }
      class Child extends Parent {
        static configResolvers = { b: () => 'child-b' };
      }

      const resolvers = getClassConfigResolvers(Child);
      expect(resolvers?.a?.()).toBe('parent-a');
      expect(resolvers?.b?.()).toBe('child-b');
    });

    it('lets subclass override parent resolver of the same name', () => {
      class Parent {
        static configResolvers = { a: () => 'parent' };
      }
      class Child extends Parent {
        static configResolvers = { a: () => 'child' };
      }

      const resolvers = getClassConfigResolvers(Child);
      expect(resolvers?.a?.()).toBe('child');
    });

    it('returns undefined when no resolvers declared anywhere', () => {
      class Bare {}
      expect(getClassConfigResolvers(Bare)).toBeUndefined();
    });

    it('handles non-functions gracefully', () => {
      expect(getClassConfigResolvers(undefined)).toBeUndefined();
      expect(getClassConfigResolvers(null)).toBeUndefined();
      expect(getClassConfigResolvers(42)).toBeUndefined();
    });
  });
});

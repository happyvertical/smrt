import type { Plugin, ResolvedConfig, UserConfig } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { smrtAssetUrlCompatibility } from './asset-url-compatibility.js';

const runtime = vi.hoisted(() => ({ version: '7.3.7' }));
vi.mock('vite', () => ({
  get version() {
    return runtime.version;
  },
}));

const unsafe = () => /new\s+URL.+import\.meta\.url/s;
function fixture(code: unknown = unsafe()) {
  const handler = vi.fn((_code: string, _id: string) => null);
  const id = { exclude: [/excluded/] };
  const filter = { id, code };
  const asset = {
    name: 'vite:asset-import-meta-url',
    transform: { filter, handler },
  };
  return { asset, filter, handler, id };
}
async function apply(plugin: Plugin, plugins: unknown[]) {
  const hook = plugin.configResolved as (
    config: ResolvedConfig,
  ) => Promise<void>;
  await hook({ plugins } as unknown as ResolvedConfig);
}
async function configure(plugin: Plugin, config: UserConfig) {
  return (
    plugin.config as (config: UserConfig) => Promise<UserConfig | undefined>
  )(config);
}

describe('smrtAssetUrlCompatibility', () => {
  it('replaces only the exact Vite 7 prefilter and preserves handler/id identity', async () => {
    runtime.version = '7.3.7';
    const f = fixture();
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    expect(f.filter.code).toBe('import.meta.url');
    expect(f.asset.transform.handler).toBe(f.handler);
    expect(f.filter.id).toBe(f.id);
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each([
    '6.4.1',
    '8.3.3',
    'unknown',
  ])('does not modify Vite %s', async (version) => {
    runtime.version = version;
    const f = fixture();
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    expect(f.filter.code).toBeInstanceOf(RegExp);
    expect(await configure(smrtAssetUrlCompatibility(), {})).toBeUndefined();
  });

  it('leaves unknown filters, handlers, and other plugins untouched; is idempotent', async () => {
    runtime.version = '7.3.7';
    for (const code of [
      /different/,
      /new\s+URL.+import\.meta\.url/g,
      null,
      'import.meta.url',
    ]) {
      const f = fixture(code);
      await apply(smrtAssetUrlCompatibility(), [f.asset]);
      expect(f.filter.code).toBe(code);
    }
    const f = fixture();
    await apply(smrtAssetUrlCompatibility(), [{ ...f.asset, name: 'other' }]);
    expect(f.filter.code).toBeInstanceOf(RegExp);
    await apply(smrtAssetUrlCompatibility(), [
      { name: 'vite:asset-import-meta-url', transform: vi.fn() },
    ]);
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    expect(f.filter.code).toBe('import.meta.url');
  });

  it('includes every previous positive static/template URL and safely filters large no-match code', async () => {
    runtime.version = '7.3.7';
    const examples = [
      'new URL("./asset.png", import.meta.url)',
      `new\nURL(\`./asset-\${name}.png\`, import.meta.url)`,
      '// new URL("./ignored.png", import.meta.url)',
      'new URL("./asset.png", /* comment */ import.meta.url)',
      `const huge = "${'x'.repeat(6_817_321)}"; new URL("./asset.png", import.meta.url)`,
    ];
    const f = fixture();
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    for (const code of examples) {
      expect(unsafe().test(code)).toBe(true);
      expect(code.includes(String(f.filter.code))).toBe(true);
    }
    const noMatch = `const huge = "${'x'.repeat(6_817_321)}";`;
    expect(noMatch.includes(String(f.filter.code))).toBe(false);
    expect(f.handler).not.toHaveBeenCalled();
    // A broader filter deliberately passes decoys to Vite's unchanged parser.
    expect(
      'const text = "import.meta.url"'.includes(String(f.filter.code)),
    ).toBe(true);
    expect(f.handler('const text = "import.meta.url"', 'decoy.js')).toBeNull();
  });

  it('composes async worker factories once, preserves arguments/order, and does not recurse', async () => {
    runtime.version = '7.3.7';
    const existing: Plugin = { name: 'existing-worker' };
    const factory = vi.fn(async () => [existing]);
    const config = await configure(smrtAssetUrlCompatibility(), {
      worker: { plugins: factory },
    } as unknown as UserConfig);
    const workerFactory = config?.worker?.plugins;
    expect(workerFactory).toBeTypeOf('function');
    const chain = ['entry.js'];
    const plugins = (workerFactory as (...args: unknown[]) => unknown[])(chain);
    expect(factory).toHaveBeenCalledExactlyOnceWith(chain);
    expect(await plugins[0]).toEqual([existing]);
    const worker = plugins?.[1] as Plugin;
    expect(worker.config).toBeUndefined();
    const f = fixture();
    await apply(worker, [f.asset]);
    expect(f.filter.code).toBe('import.meta.url');
    const empty = await configure(smrtAssetUrlCompatibility(), {});
    expect((await empty?.worker?.plugins?.())?.[1]).toHaveProperty(
      'name',
      'smrt-asset-url-compatibility',
    );
  });
});

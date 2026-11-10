import {
  type Plugin,
  parseAst,
  type ResolvedConfig,
  type UserConfig,
} from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { smrtAssetUrlCompatibility } from './asset-url-compatibility.js';

const runtime = vi.hoisted(() => ({ version: '7.3.7' }));
vi.mock('../utils/import-project-vite.js', () => ({
  importProjectVite: vi.fn(async () => ({
    ...(await vi.importActual<typeof import('vite')>('vite')),
    version: runtime.version,
  })),
}));

const unsafe = () => /new\s+URL.+import\.meta\.url/s;
function fixture(code: unknown = unsafe()) {
  const handler = vi.fn(
    (_code: string, _id: string, ..._args: unknown[]) => null,
  );
  const id = { exclude: [/excluded/] };
  const filter = { id, code };
  const asset = {
    name: 'vite:asset-import-meta-url',
    transform: { filter, handler },
  };
  return { asset, filter, handler, id };
}
async function apply(plugin: Plugin, plugins: unknown[]) {
  if (plugin.config) await configure(plugin, {});
  const hook = plugin.configResolved as (config: ResolvedConfig) => void;
  hook({ plugins } as unknown as ResolvedConfig);
}
async function configure(plugin: Plugin, config: UserConfig) {
  return (
    plugin.config as (config: UserConfig) => Promise<UserConfig | undefined>
  )(config);
}

describe('smrtAssetUrlCompatibility', () => {
  it('mutates root and worker filters synchronously before the resolved hook returns', async () => {
    runtime.version = '7.3.7';
    const root = smrtAssetUrlCompatibility();
    const config: UserConfig = {};
    await configure(root, config);
    const worker = config.worker?.plugins?.()[1] as Plugin;
    for (const plugin of [root, worker]) {
      const f = fixture();
      const hook = plugin.configResolved as (config: ResolvedConfig) => unknown;
      const result = hook({ plugins: [f.asset] } as unknown as ResolvedConfig);
      expect(result).toBeUndefined();
      expect(f.filter.code).toBe('import.meta.url');
      expect(
        f.asset.transform.handler.call(
          { parse: parseAst },
          '/* import.meta.url */',
          'worker.js',
        ),
      ).toBeNull();
      expect(f.handler).not.toHaveBeenCalled();
    }
  });

  it('replaces only the exact Vite 7 prefilter and preserves id identity', async () => {
    runtime.version = '7.3.7';
    const f = fixture();
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    expect(f.filter.code).toBe('import.meta.url');
    expect(f.asset.transform.handler).not.toBe(f.handler);
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
    // The linear prefilter may include decoys; the AST guard rejects them.
    expect(
      'const text = "import.meta.url"'.includes(String(f.filter.code)),
    ).toBe(true);
    expect(
      f.asset.transform.handler.call(
        { parse: parseAst },
        'const text = "import.meta.url"',
        'decoy.js',
      ),
    ).toBeNull();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each([
    ['comment', '/* new URL("./asset.png", import.meta.url) */', false],
    ['string', 'const text="new URL(asset, import.meta.url)"', false],
    ['static', 'new URL("./asset.png", import.meta.url)', true],
    ['template', `new URL(\`./asset/\${name}.png\`, import.meta.url)`, true],
    ['computed', 'const value=import.meta["url"]', true],
    ['unknown usage', 'const value=import.meta', true],
    ['nested', 'function f(){ return ()=>import.meta.url }', true],
  ])('guards %s eligibility using the bundler AST', async (_name, code, eligible) => {
    const f = fixture();
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    const context = { parse: vi.fn(parseAst) };
    expect(
      f.asset.transform.handler.call(context, code, 'fixture.js'),
    ).toBeNull();
    expect(context.parse).toHaveBeenCalledExactlyOnceWith(code);
    expect(f.handler).toHaveBeenCalledTimes(eligible ? 1 : 0);
    if (eligible)
      expect(f.handler).toHaveBeenCalledExactlyOnceWith(code, 'fixture.js');
  });

  it('avoids the tokenizer for huge escaped literals with comment-only asset examples', async () => {
    const code = `const huge="${'\\n'.repeat(100_000)}"; /* new URL("./asset.png", import.meta.url) */`;
    const f = fixture();
    const failure = new RangeError('tokenizer stack overflow');
    f.handler.mockImplementation(() => {
      throw failure;
    });
    // Causal baseline: the original handler is reached by the old loose filter.
    expect(unsafe().test(code)).toBe(true);
    expect(() => f.handler(code, 'large.js')).toThrow(failure);
    f.handler.mockClear();
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    expect(
      f.asset.transform.handler.call({ parse: parseAst }, code, 'large.js'),
    ).toBeNull();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it('delegates with identical context, arguments, return value, and rejection', async () => {
    const f = fixture();
    const context = { parse: parseAst };
    const code = 'new URL("./asset.png", import.meta.url)';
    const options = { ssr: false };
    const result = Promise.resolve(null);
    f.handler.mockReturnValue(result as never);
    await apply(smrtAssetUrlCompatibility(), [f.asset]);
    expect(
      f.asset.transform.handler.call(context, code, 'asset.js', options),
    ).toBe(result);
    expect(f.handler.mock.contexts[0]).toBe(context);
    expect(f.handler).toHaveBeenCalledExactlyOnceWith(
      code,
      'asset.js',
      options,
    );
    const error = new Error('original rejection');
    const rejected = Promise.reject(error);
    f.handler.mockReturnValue(rejected as never);
    expect(
      f.asset.transform.handler.call(context, code, 'asset.js', options),
    ).toBe(rejected);
    await expect(rejected).rejects.toBe(error);
    f.handler.mockImplementation(() => {
      throw error;
    });
    expect(() =>
      f.asset.transform.handler.call(context, code, 'asset.js', options),
    ).toThrow(error);
  });

  it('conservatively delegates on parser failure, unavailable parser, and exhausted walk budget', async () => {
    for (const context of [
      {
        parse() {
          throw new SyntaxError('unsupported syntax');
        },
      },
      {},
      {
        parse() {
          return null;
        },
      },
      {
        parse() {
          const cyclic: { child?: unknown } = {};
          cyclic.child = cyclic;
          return { type: 'Program', body: [cyclic] };
        },
      },
    ]) {
      const f = fixture();
      await apply(smrtAssetUrlCompatibility(), [f.asset]);
      expect(
        f.asset.transform.handler.call(context, 'unknown', 'fixture.js'),
      ).toBeNull();
      expect(f.handler).toHaveBeenCalledExactlyOnceWith(
        'unknown',
        'fixture.js',
      );
    }
  });

  it('composes async worker factories once, preserves arguments/order, and does not recurse', async () => {
    runtime.version = '7.3.7';
    const existing: Plugin = { name: 'existing-worker' };
    const factory = vi.fn(async () => [existing]);
    const config = {
      worker: { plugins: factory },
    } as unknown as UserConfig;
    await configure(smrtAssetUrlCompatibility(), config);
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
    const empty: UserConfig = {};
    await configure(smrtAssetUrlCompatibility(), empty);
    expect((await empty?.worker?.plugins?.())?.[1]).toHaveProperty(
      'name',
      'smrt-asset-url-compatibility',
    );
  });
});

/**
 * The eager `.smrt/register.js` write completes or fails (#5462): a short
 * write by the descriptor writer never passes as a finished registration.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const shortWrites = vi.hoisted(() => ({ enabled: false }));

// `fs.writeSync` writes at most half of what it is given: a short write a
// full disk or quota can produce, reported only through the byte count.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeSync = ((
    descriptor: number,
    data: unknown,
    ...rest: unknown[]
  ) => {
    if (shortWrites.enabled && typeof data === 'string' && data.length > 1) {
      const half = data.slice(0, Math.floor(data.length / 2));
      return (actual.writeSync as (...args: unknown[]) => number)(
        descriptor,
        half,
      );
    }
    return (actual.writeSync as (...args: unknown[]) => number)(
      descriptor,
      data,
      ...rest,
    );
  }) as typeof actual.writeSync;
  return { ...actual, default: { ...actual, writeSync }, writeSync };
});

const { smrtConsumer } = await import('./index.js');

const roots: string[] = [];
afterEach(() => {
  shortWrites.enabled = false;
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('eager consumer registration writes (#5462)', () => {
  it('a short descriptor write never leaves a truncated register.js', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-register-short-write-'));
    roots.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@fixture/short-write', type: 'module' }),
    );
    const provider = join(root, 'node_modules', '@acme', 'widgets');
    mkdirSync(join(provider, 'dist'), { recursive: true });
    writeFileSync(
      join(provider, 'package.json'),
      JSON.stringify({
        name: '@acme/widgets',
        version: '1.0.0',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(join(provider, 'dist/index.js'), 'export class Widget {}\n');
    writeFileSync(
      join(provider, 'dist/manifest.json'),
      JSON.stringify({
        packageName: '@acme/widgets',
        objects: {
          '@acme/widgets:Widget': {
            className: 'Widget',
            qualifiedName: '@acme/widgets:Widget',
            collection: 'widgets',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const plugin = smrtConsumer({
      projectRoot: root,
      packages: ['@acme/widgets'],
      disableScanning: true,
      generateTypes: false,
    }) as unknown as { buildStart: (...args: unknown[]) => Promise<void> };

    shortWrites.enabled = true;
    await plugin.buildStart.call(plugin);
    shortWrites.enabled = false;

    const registration = readFileSync(
      join(root, '.smrt', 'register.js'),
      'utf8',
    );
    expect(registration).toContain('@acme/widgets:Widget');
    expect(registration.trimEnd()).toMatch(
      /export function registerAll\(\) \{[\s\S]*\}$/,
    );
  });
});

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { smrtConsumer } from './index';

describe('smrtConsumer registration generation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(import.meta.dirname, `__test-consumer-${Date.now()}`);

    mkdirSync(join(tmpDir, 'node_modules', '@test', 'pkg', 'dist'), {
      recursive: true,
    });

    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'consumer-app',
        version: '1.0.0',
      }),
    );

    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        version: '1.2.3',
        exports: {
          '.': './dist/index.js',
        },
      }),
    );

    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'dist', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/pkg',
        objects: {
          ExternalThing: {
            className: 'ExternalThing',
            collection: 'externalthings',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should write explicit package names into .smrt/register.js', async () => {
    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await plugin.buildStart?.call({} as any);

    const registerPath = join(tmpDir, '.smrt', 'register.js');
    expect(existsSync(registerPath)).toBe(true);

    const content = readFileSync(registerPath, 'utf-8');
    expect(content).toContain(
      'ObjectRegistry.register(ExternalThing, { packageName: "@test/pkg" });',
    );
  });
});

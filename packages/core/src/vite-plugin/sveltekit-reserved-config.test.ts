/**
 * The SvelteKit config module may not take a name the generator owns (#3416
 * review F1). Generated routes import the config module as the application's
 * runtime; a config that resolves to the generated registration module would
 * be overwritten and then read as an application with no runtime.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import { generateSvelteKitRoutes } from './sveltekit-generator.js';

const AUTHORED = "export const runtime = 'authored';\n";

function manifest(projectRoot: string): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 0,
    packageName: '@test/reserved-config-app',
    objects: {
      Widget: {
        className: 'Widget',
        name: 'Widget',
        collection: 'widgets',
        qualifiedName: '@test/reserved-config-app:Widget',
        decoratorConfig: { api: true },
        fields: {},
        filePath: join(projectRoot, 'src/lib/objects/Widget.ts'),
        methods: {},
      },
    },
  } as SmartObjectManifest;
}

/** Every file under `dir`, with its bytes, for a no-write assertion. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[path] = readFileSync(path, 'utf-8');
    }
  };
  walk(dir);
  return files;
}

describe('SvelteKit config module name reservation', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-reserved-config-'));
    mkdirSync(join(projectRoot, 'src/lib/objects'), { recursive: true });
    mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'src/lib/objects/Widget.ts'),
      'export class Widget {}\n',
    );
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function options(configFileName: string, configPath = 'src/lib/server') {
    return {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath,
      configFileName,
    };
  }

  it.each([
    'smrt-register.ts',
    'smrt-register.js',
    'smrt-register.mts',
    'smrt-register',
    'SMRT-Register.ts',
    './smrt-register.ts',
  ])('rejects configFileName %s before writing anything', async (configFileName) => {
    const authored = join(
      projectRoot,
      'src/lib/server',
      configFileName.replace(/^\.\//, ''),
    );
    writeFileSync(authored, AUTHORED);
    const before = snapshot(projectRoot);

    await expect(
      generateSvelteKitRoutes(
        projectRoot,
        manifest(projectRoot),
        options(configFileName),
      ),
    ).rejects.toThrow(/reserved for the generated registration module/);

    expect(snapshot(projectRoot)).toEqual(before);
    expect(readFileSync(authored, 'utf-8')).toBe(AUTHORED);
    expect(existsSync(join(projectRoot, 'src/routes'))).toBe(false);
  });

  it('rejects a configPath/configFileName pair that lands on the register module', async () => {
    const before = snapshot(projectRoot);
    await expect(
      generateSvelteKitRoutes(
        projectRoot,
        manifest(projectRoot),
        options('../server/smrt-register.ts', 'src/lib/objects'),
      ),
    ).rejects.toThrow(/reserved for the generated registration module/);
    expect(snapshot(projectRoot)).toEqual(before);
  });

  it('keeps a custom non-reserved config file authored and routes importing it', async () => {
    const authored = join(projectRoot, 'src/lib/server/app-smrt.ts');
    writeFileSync(authored, AUTHORED);

    await generateSvelteKitRoutes(
      projectRoot,
      manifest(projectRoot),
      options('app-smrt.ts'),
    );

    expect(readFileSync(authored, 'utf-8')).toBe(AUTHORED);
    expect(
      readFileSync(
        join(projectRoot, 'src/lib/server/smrt-register.ts'),
        'utf-8',
      ),
    ).toContain('Auto-generated SMRT object registration');
    const route = readFileSync(
      join(projectRoot, 'src/routes/api/widgets/+server.ts'),
      'utf-8',
    );
    expect(route).toContain("import '$lib/server/smrt-register';");
    expect(route).toContain(
      "import * as smrtApplication from '$lib/server/app-smrt';",
    );
  });
});

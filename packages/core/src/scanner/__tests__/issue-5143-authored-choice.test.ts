/**
 * #5143: manifest generation reads a same-named subclass's `replaceParent`
 * from its own decorator, never from the parent it inherits configuration
 * from. Sources are scanned with the real scanner across an installed
 * provider, an installed library and an app.
 */
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isReplacedModel } from '../../manifest/model-replacements';
import { createConsumerWorkspace } from '../../registry/__tests__/helpers/consumer-workspace';
import { ManifestGenerator } from '../manifest-generator';
import type { SmartObjectManifest } from '../types';

const VIDEO = '@fixture/c5143-video';
const LIB = '@fixture/c5143-lib';
const APP = '@fixture/c5143-app';

let ws: ReturnType<typeof createConsumerWorkspace>;
let cwd: string;
let video: SmartObjectManifest;

async function scan(root: string, pkg: string, deps: string[] = []) {
  const { resolved } = await new OxcScanner({
    cwd: root,
    include: ['src/**/*.ts'],
  }).scanAndResolve();
  const manifest = new ManifestAdapter().toManifest(resolved, {
    packageName: pkg,
  }) as SmartObjectManifest;
  manifest.smrtDependencies = deps;
  new ManifestGenerator().applyGenerationPasses(manifest, { packageName: pkg });
  return manifest;
}

/** Install a scanned package under node_modules with its built manifest. */
async function install(pkg: string, source: string, deps: string[] = []) {
  const dir = `node_modules/${pkg}`;
  ws.write(
    `${dir}/package.json`,
    JSON.stringify({
      name: pkg,
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './manifest.json': './dist/manifest.json',
      },
    }),
  );
  ws.write(`${dir}/dist/index.js`, 'export {};');
  ws.write(`${dir}/src/models.ts`, source);
  const manifest = await scan(ws.path(dir), pkg, deps);
  ws.write(`${dir}/dist/manifest.json`, JSON.stringify(manifest));
  return manifest;
}

beforeEach(async () => {
  ws = createConsumerWorkspace('smrt-5143-authored');
  cwd = process.cwd();
  ws.writePackage('app', APP);
  process.chdir(ws.path('app'));
  video = await install(
    VIDEO,
    `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
@smrt({ tableName: 'c5143_scenes', tableStrategy: 'sti', collection: 'clips' })
export class Scene extends SmrtObject { title = ''; }
`,
  );
});
afterEach(() => {
  process.chdir(cwd);
  ws.dispose();
});

describe('authored same-name choice in manifest generation', () => {
  it('refuses an app class that declares nothing, even when the library class it extends declared replaceParent: true', async () => {
    await install(
      LIB,
      `import { smrt } from '@happyvertical/smrt-core';
import { Scene as VideoScene } from '${VIDEO}';
@smrt({ replaceParent: true })
export class Scene extends VideoScene { mood = ''; }
`,
      [VIDEO],
    );
    ws.write(
      'app/src/models.ts',
      `import { smrt } from '@happyvertical/smrt-core';
import { Scene as LibScene } from '${LIB}';
@smrt({})
export class Scene extends LibScene { badge = ''; }
`,
    );
    await expect(scan(ws.path('app'), APP, [VIDEO, LIB])).rejects.toMatchObject(
      {
        code: 'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED',
        message: expect.stringContaining(`${APP}:Scene extends ${LIB}:Scene`),
      },
    );
  });

  it("gives a declared replacement its parent's table and replaces the parent", async () => {
    ws.write(
      'app/src/models.ts',
      `import { smrt } from '@happyvertical/smrt-core';
import { Scene as VideoScene } from '${VIDEO}';
@smrt({ replaceParent: true })
export class Scene extends VideoScene { badge = ''; }
`,
    );
    const app = await scan(ws.path('app'), APP, [VIDEO]);
    const entry = app.objects[`${APP}:Scene`];
    expect(entry.decoratorConfig.replaceParent).toBe(true);
    expect(entry.decoratorConfig.tableName).toBe('c5143_scenes');
    const merged: SmartObjectManifest = {
      ...app,
      objects: { ...video.objects, ...app.objects },
    };
    expect(isReplacedModel(merged, video.objects[`${VIDEO}:Scene`])).toBe(true);
    expect(isReplacedModel(merged, entry)).toBe(false);
  });
});

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

const cliRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runInNode(code: string): void {
  execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: cliRoot,
  });
}

it('does not register asset models when Node imports the built locator entry', () => {
  runInNode(`
    import assert from 'node:assert/strict';
    import { ObjectRegistry } from '@happyvertical/smrt-core';

    const before = ObjectRegistry.getQualifiedClassNames();
    const registeredPackages = [];
    const registerPackageManifest = ObjectRegistry.registerPackageManifest;
    ObjectRegistry.registerPackageManifest = function (...args) {
      const result = registerPackageManifest.apply(this, args);
      registeredPackages.push(result.packageName);
      return result;
    };

    await import('@happyvertical/smrt-assets/locator');

    assert.deepEqual(ObjectRegistry.getQualifiedClassNames(), before);
    assert.deepEqual(registeredPackages, []);
  `);
});

it('does not import the asset model entry directly from the built CLI app', () => {
  runInNode(`
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';

    const appURL = import.meta.resolve('@happyvertical/smrt-cli/app');
    const distURL = new URL('.', appURL).href;
    const assetRootImporters = [];
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        // Runtime dependencies may load assets for their own models. The
        // CLI bundle itself must use the locator entry for asset portability.
        if (specifier === '@happyvertical/smrt-assets' &&
            context.parentURL?.startsWith(distURL)) {
          assetRootImporters.push(context.parentURL);
        }
        return nextResolve(specifier, context);
      },
    });
    try {
      await import('@happyvertical/smrt-cli/app');
      assert.deepEqual(assetRootImporters, []);
    } finally {
      hooks.deregister();
    }
  `);
});

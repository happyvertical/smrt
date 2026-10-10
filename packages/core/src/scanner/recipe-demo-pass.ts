/**
 * Manifest pass for browser-demo metadata (#3709).
 *
 * Reads the package's browser capability from the table generated out of the
 * bundle-gate (`manifest/browser-capability.generated.ts`), emits it as the
 * manifest's `browser`, and classifies each recipe into `demo`. Contradictory
 * declarations (see {@link deriveRecipeDemo}) fail the build, like the other
 * recipe assertions. Idempotent: the passes may run more than once.
 */

import { PACKAGE_BROWSER_CAPABILITY } from '../manifest/browser-capability.generated.js';
import { deriveRecipeDemo } from '../recipe-demo.js';
import type { SmartObjectManifest } from './types.js';

/** The bundle-gate capability of a workspace package, or `undefined` when unmeasured. */
export function getPackageBrowserCapability(packageName: string | undefined) {
  return packageName && Object.hasOwn(PACKAGE_BROWSER_CAPABILITY, packageName)
    ? PACKAGE_BROWSER_CAPABILITY[packageName]
    : undefined;
}

export function applyRecipeDemo(
  manifest: SmartObjectManifest,
  packageName: string | undefined,
): void {
  const capability = getPackageBrowserCapability(packageName);
  if (capability) manifest.browser = capability;
  else delete manifest.browser;

  const problems: string[] = [];
  for (const recipe of manifest.recipes ?? []) {
    const { demo, problems: found } = deriveRecipeDemo(recipe, capability);
    problems.push(...found);
    if (demo) recipe.demo = demo;
    else delete recipe.demo;
  }
  if (problems.length > 0) {
    throw new Error(
      `[manifest-generator] contradictory recipe demo declarations:\n  ${problems.join('\n  ')}`,
    );
  }
}

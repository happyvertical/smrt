/**
 * Self-registers this package's build-time manifest before any @smrt()
 * decorator in the package fires. Same pattern as smrt-prompts — see
 * packages/prompts/src/__smrt-register__.ts and issue #1132 for context.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';

ObjectRegistry.registerPackageManifest(
  new URL('./manifest.json', import.meta.url),
);

/** Register provider metadata before decorators run in consumer bundles. */
import { ObjectRegistry } from '@happyvertical/smrt-core';

// smrtPlugin embeds the build-time manifest here for published output. Source
// runs use the URL fallback; the test plugin supplies its own manifest.
ObjectRegistry.registerPackageManifest(
  new URL('./manifest.json', import.meta.url),
);

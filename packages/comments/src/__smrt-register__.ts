import { ObjectRegistry } from '@happyvertical/smrt-core';

ObjectRegistry.registerPackageManifest(
  new URL('./manifest.json', import.meta.url),
);

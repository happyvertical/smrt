// Publish the shell's own object manifest. The smrt() plugin writes
// `.smrt/manifest.json` for the whole app (its objects plus every consumed
// package's); the release guards (verify-manifest-completeness,
// verify-manifest-exports) expect `dist/manifest.json` to list this package's
// own objects, so keep those and write them where `./manifest` exports point.
//
// A manifest's `schemaFingerprint` describes the objects in that file. The
// source stamp covers the whole app, so it is not copied: the stamp is computed
// again for the objects written, with the function the generators use. This
// file is a library manifest, never the app's build (the build is
// `.smrt/manifest.json`; see core `PROJECT_MANIFEST_PATHS`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tryComputeManifestSchemaFingerprint } from '@happyvertical/smrt-core/migrations';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const source = JSON.parse(
  readFileSync(join(root, '.smrt', 'manifest.json'), 'utf8'),
);
const prefix = `${pkg.name}:`;
// The app build records absolute source paths; a published manifest must not
// depend on the build machine, so write them relative to this package (#4948).
const portable = (object) =>
  typeof object.filePath === 'string' && isAbsolute(object.filePath)
    ? {
        ...object,
        filePath: relative(root, object.filePath).split('\\').join('/'),
      }
    : object;
const objects = Object.fromEntries(
  Object.entries(source.objects ?? {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, object]) => [key, portable(object)]),
);
const { schemaFingerprint: _appStamp, ...rest } = source;
const manifest = {
  ...rest,
  packageName: pkg.name,
  packageVersion: pkg.version,
  objects,
};
const stamp = tryComputeManifestSchemaFingerprint(manifest, (error) =>
  console.warn(`[publish-manifest] no schema fingerprint: ${error.message}`),
);
if (stamp) manifest.schemaFingerprint = stamp;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(
  join(root, 'dist', 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `[publish-manifest] ${Object.keys(objects).length} object(s) -> dist/manifest.json`,
);

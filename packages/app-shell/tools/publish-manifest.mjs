// Publish the shell's own object manifest. The smrt() plugin writes
// `.smrt/manifest.json` for the whole app (its objects plus every consumed
// package's); the release guards (verify-manifest-completeness,
// verify-manifest-exports) expect `dist/manifest.json` to list this package's
// own objects, so keep those and write them where `./manifest` exports point.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(
  join(root, 'dist', 'manifest.json'),
  `${JSON.stringify({ ...source, packageName: pkg.name, packageVersion: pkg.version, objects }, null, 2)}\n`,
);
console.log(
  `[publish-manifest] ${Object.keys(objects).length} object(s) -> dist/manifest.json`,
);

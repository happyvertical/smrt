// Publish the shell's own object manifest. The smrt() plugin writes
// `.smrt/manifest.json` for the whole app (its objects plus every consumed
// package's); the release guards (verify-manifest-completeness,
// verify-manifest-exports) expect `dist/manifest.json` to list this package's
// own objects, so keep those and write them where `./manifest` exports point.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const source = JSON.parse(
  readFileSync(join(root, '.smrt', 'manifest.json'), 'utf8'),
);
const prefix = `${pkg.name}:`;
const objects = Object.fromEntries(
  Object.entries(source.objects ?? {}).filter(([key]) => key.startsWith(prefix)),
);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(
  join(root, 'dist', 'manifest.json'),
  `${JSON.stringify({ ...source, packageName: pkg.name, packageVersion: pkg.version, objects }, null, 2)}\n`,
);
console.log(
  `[publish-manifest] ${Object.keys(objects).length} object(s) -> dist/manifest.json`,
);

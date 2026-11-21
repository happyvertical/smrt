// Every file the package.json `exports` and `bin` name must exist (#5494).
// `prepack-package.js` runs this as `verify:exports`, also on a build reused
// from CI: a `dist/` carried without `build/` (the server build) fails here and
// is rebuilt instead of published without its start entry.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const targets = [];
const walk = (value) => {
  if (typeof value === 'string') targets.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(walk);
};
walk(pkg.exports);
walk(pkg.bin);
const missing = targets.filter((t) => !existsSync(join(root, t)));
if (missing.length) {
  console.error(`[verify-exports] missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`[verify-exports] ${targets.length} entries present`);

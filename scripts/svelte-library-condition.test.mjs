import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// vite-plugin-svelte treats a dependency as a Svelte library, and so compiles
// its `.svelte` files instead of handing them to the dev prebundler, only when
// its package.json has a `svelte` export condition or a top-level `svelte`
// field (`isFrameworkPkgByJson`). Without either, `vite dev` in a consumer
// fails with `No loader is configured for ".svelte" files` (#3843).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOT_SHIPPED = /(^|\/)(__tests__|__fixtures__|fixtures|tests?|stories)\//;

function shipsSvelte(dir, prefix = '') {
  let entries;
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return entry.name !== 'node_modules' && shipsSvelte(dir, path);
    }
    return (
      entry.name.endsWith('.svelte') &&
      !/\.(test|spec|fixture)\.svelte$/.test(entry.name) &&
      !NOT_SHIPPED.test(`${path}`)
    );
  });
}

function declaresSvelte(manifest) {
  if (manifest.svelte) return true;
  let found = false;
  JSON.stringify(manifest.exports ?? {}, (key, value) => {
    if (key === 'svelte') found = true;
    return value;
  });
  return found;
}

test('every published package that ships .svelte declares a svelte condition or field', () => {
  const offenders = [];
  let checked = 0;
  for (const entry of readdirSync(join(root, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, 'packages', entry.name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest.private || !shipsSvelte(join(dir, 'src'))) continue;
    checked++;
    if (!declaresSvelte(manifest)) offenders.push(manifest.name);
  }
  assert.ok(checked > 0, 'found no package that ships .svelte');
  assert.deepEqual(offenders, []);
});

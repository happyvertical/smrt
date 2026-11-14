#!/usr/bin/env node
// Keeps the Tauri wrapper crate's version equal to the
// @happyvertical/smrt-desktop package version (smrt#4965): Cargo.toml
// `[package] version` and the wrapper's own entry in Cargo.lock.
//
//   node scripts/sync-desktop-wrapper-version.mjs          # write
//   node scripts/sync-desktop-wrapper-version.mjs --check  # exit 1 on drift
//
// `smrt desktop build` refuses a wrapper whose version differs from the
// installed package version, and `packages/smrt-desktop/src/builder/
// version-sync.test.ts` fails on drift, so run this after every version bump
// (the root `changeset:version` script does). Node built-ins only.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'packages', 'smrt-desktop');
const wrapperDir = join(packageDir, 'wrapper');

export function syncCargoToml(text, version) {
  let inPackage = false;
  let done = false;
  const lines = text.split('\n').map((line) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) inPackage = header[1] === 'package';
    if (inPackage && !done && /^\s*version\s*=\s*"[^"]*"/.test(line)) {
      done = true;
      return line.replace(/"[^"]*"/, `"${version}"`);
    }
    return line;
  });
  if (!done) throw new Error('Cargo.toml has no [package] version');
  return lines.join('\n');
}

export function syncCargoLock(text, version, name = 'smrt-desktop-wrapper') {
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")[^"]*(")`,
  );
  if (!pattern.test(text)) throw new Error('Cargo.lock has no wrapper entry');
  return text.replace(pattern, `$1${version}$2`);
}

export function main(argv) {
  const check = argv.includes('--check');
  const { version } = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  );
  const files = [
    ['Cargo.toml', syncCargoToml],
    ['Cargo.lock', syncCargoLock],
  ];
  let drift = false;
  for (const [name, sync] of files) {
    const path = join(wrapperDir, name);
    const before = readFileSync(path, 'utf8');
    const after = sync(before, version);
    if (after === before) continue;
    drift = true;
    if (!check) writeFileSync(path, after);
  }
  if (check && drift) {
    console.error(
      'the wrapper version differs from the package version; run node scripts/sync-desktop-wrapper-version.mjs',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

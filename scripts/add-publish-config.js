#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const packagesDir = 'packages';
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name);

const publishConfig = {
  registry: 'https://npm.pkg.github.com',
  access: 'public'
};

for (const dir of packageDirs) {
  const file = join(packagesDir, dir, 'package.json');

  try {
    const content = readFileSync(file, 'utf-8');
    const pkg = JSON.parse(content);

    if (!pkg.publishConfig) {
      pkg.publishConfig = publishConfig;
      writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`✅ Added publishConfig to ${file}`);
    } else {
      console.log(`⏭️  Skipped ${file} (already has publishConfig)`);
    }
  } catch (err) {
    console.log(`⚠️  Skipped ${dir} (no package.json)`);
  }
}

console.log('\n✅ Done!');

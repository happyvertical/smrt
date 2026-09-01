import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveLocalRuntimePaths } from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import { resolveApplicationId } from './smrt-runtime-identity.mjs';

const sourceRoot = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
);
const appId = resolveApplicationId({
  sourceRoot,
  packageName: packageJson.name,
  explicitId: process.env.SMRT_APP_ID,
});

await loadConfig({ cache: false });
const runtime = resolveConfiguredApplicationRuntime();
if (runtime.profile === 'local') {
  const paths = resolveLocalRuntimePaths({
    appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot,
  });
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.assets, { recursive: true, mode: 0o700 });
}

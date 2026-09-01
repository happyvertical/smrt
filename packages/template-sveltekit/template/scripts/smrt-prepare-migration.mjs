import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { prepareLocalDatabaseStorage } from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import {
  resolveApplicationId,
  resolveApplicationStateRoot,
} from './smrt-runtime-identity.mjs';
import { readActiveWriterLease } from './smrt-writer-lease.mjs';

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
  const stateRoot = resolveApplicationStateRoot({
    appId,
    explicitStateDirectory: process.env.SMRT_STATE_DIR,
  });
  if (readActiveWriterLease(stateRoot)) {
    throw new Error('Stop the local application before preparing its schema.');
  }
  await prepareLocalDatabaseStorage({
    appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot,
  });
}

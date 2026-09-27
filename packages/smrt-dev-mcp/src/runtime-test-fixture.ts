import { mkdirSync, symlinkSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';

/** Model a consumer installation without letting the loader borrow server deps. */
export function installRuntimeFixture(root: string): void {
  const core = findPackageJSON('@happyvertical/smrt-core', import.meta.url);
  if (!core) throw new Error('Build the workspace runtime before testing');
  const scope = join(root, 'node_modules', '@happyvertical');
  mkdirSync(scope, { recursive: true });
  symlinkSync(dirname(core), join(scope, 'smrt-core'), 'dir');
}

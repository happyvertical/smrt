import { installTestHome } from './test-home.js';

// Only the public global-setup fields used here, shared by Vitest 2 and newer.
interface SetupProject {
  config: { hookTimeout: number };
  provide(key: '__smrtVitestManifestHookTimeout', value: number): void;
}

/** Runs in the coordinator before any workers or application children exist. */
export default function setup(project: SetupProject): () => void {
  // Global setup sees the final per-project config, including CLI overrides.
  // Forward only this hook's budget; setup.ts leaves global defaults alone.
  project.provide(
    '__smrtVitestManifestHookTimeout',
    project.config.hookTimeout,
  );
  return installTestHome();
}

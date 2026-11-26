import { installTestHome } from './test-home.js';

// Only the public global-setup fields used here, shared by Vitest 2 and newer.
interface SetupProject {
  config: { hookTimeout: number };
  provide(key: '__smrtVitestManifestHookTimeout', value: number): void;
}

function isSetupProject(project: unknown): project is SetupProject {
  return (
    typeof project === 'object' &&
    project !== null &&
    'config' in project &&
    typeof project.config === 'object' &&
    project.config !== null &&
    'hookTimeout' in project.config &&
    typeof project.config.hookTimeout === 'number' &&
    Number.isFinite(project.config.hookTimeout) &&
    project.config.hookTimeout >= 0 &&
    'provide' in project &&
    typeof project.provide === 'function'
  );
}

/** Runs in the coordinator before any workers or application children exist. */
export default function setup(project?: unknown): () => void {
  // This home-isolation entry is also used by Playwright and standalone callers.
  // Only Vitest supplies the public config/provide context for hook budgets.
  if (isSetupProject(project)) {
    project.provide(
      '__smrtVitestManifestHookTimeout',
      project.config.hookTimeout,
    );
  }
  return installTestHome();
}

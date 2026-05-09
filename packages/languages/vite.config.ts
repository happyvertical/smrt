import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('languages', {
  // Catch declaration regressions on the public API.
  strictDts: true,
  // Translation-job and CLI APIs live on subpaths so importing the package
  // root for `defineLanguageString` / `resolveLanguageString` does not drag
  // jobs/features/prompts/AI into every consumer bundle. See README and
  // `index.ts` for the contract.
  entries: ['jobs', 'cli'],
});

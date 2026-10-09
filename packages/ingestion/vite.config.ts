import { createPackageConfig } from '../../vite.config.base.js';
export default createPackageConfig('ingestion', {
  entries: ['dto', 'models', 'server', 'extraction-worker', 'execution', 'proposals'],
  dtsExclude: ['src/test-support/**'],
});

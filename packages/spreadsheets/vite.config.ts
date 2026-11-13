import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('spreadsheets', {
  entries: [{ name: 'import/index', source: 'src/import/index.ts' }, 'testing'],
});

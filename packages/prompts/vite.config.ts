import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('prompts', {
  // Keep exported prompt APIs honest by failing library builds if declaration
  // generation surfaces a real TS error.
  strictDts: true,
});

import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('projects', {
  entries: ['ui', 'playground', 'project-board-types'],
  svelte: 'svelte',
});

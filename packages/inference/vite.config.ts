import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('inference', {
  entries: [
    'node', 'resolver', 'gate', 'models', 'server',
    { name: 'agent-cli/test-support', source: 'src/agent-cli/test-support.ts' },
  ],
  svelte: 'svelte',
});

import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('smrt-app-mcp', {
  entries: [
    'sveltekit',
    'cli',
    { name: 'bin/smrt-mcp-bridge', source: 'src/cli-bin.ts' },
  ],
});

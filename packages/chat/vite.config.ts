import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('chat', {
  entries: [
    'ui',
    'playground',
    // Internal agent-runtime surface (S5 #1392): emitted under a dedicated
    // subpath, NOT folded into the package index, so only trusted in-process
    // agent runtimes opt into `sendAgentReply`.
    { name: 'internal/agent-runtime', source: 'src/internal/agent-runtime.ts' },
  ],
  svelte: 'svelte',
});

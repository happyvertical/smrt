import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('smrt-desktop', {
  entries: [
    // Node-only runtime bundler (`smrt desktop bundle`). The root entry must
    // never import it.
    { name: 'bundler', source: 'src/bundler/index.ts' },
    // Node-only launcher core for assistant plugins (#4729): diagnostics,
    // trust checks and the stdio lifecycle around an injected provider.
    { name: 'launcher', source: 'src/launcher/index.ts' },
  ],
  // Test-only fixtures must not ship as published types.
  dtsExclude: ['src/testing/**', 'src/**/testing/**'],
});

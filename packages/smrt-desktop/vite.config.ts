import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('smrt-desktop', {
  entries: [
    // Browser-safe entry for the signed-in desktop webview: no Node built-ins.
    { name: 'webview', source: 'src/webview/index.ts' },
    // Node-only runtime bundler (`smrt desktop bundle`). The root entry and
    // `./webview` must never import it.
    { name: 'bundler', source: 'src/bundler/index.ts' },
    // Node-only reference servers and test doubles (`/testing`). Not a
    // production surface: the real server, writer and custody are the shell's.
    { name: 'testing', source: 'src/testing.ts' },
  ],
  // Test-only fixtures must not ship as published types.
  dtsExclude: ['src/testing/**', 'src/**/testing/**'],
});

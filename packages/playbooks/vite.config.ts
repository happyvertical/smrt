import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('playbooks', {
  // `dist/index.d.ts` re-exports the preflight contract types from
  // `./preflight-types.js`, so that module must be emitted as its own build
  // entry or the packed tarball fails packed-export verification.
  entries: ['preflight-types'],
  // Keep exported playbook APIs honest by failing library builds if
  // declaration generation surfaces a real TS error.
  strictDts: true,
});

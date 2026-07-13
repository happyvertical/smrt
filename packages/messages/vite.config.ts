import { createPackageConfig } from '../../vite.config.base.js';

export default createPackageConfig('messages', {
  entries: [
    'ui',
    'playground',
    // Explicit provider entry points (#1979): the only modules allowed to
    // reference the provider SDK wrappers (@happyvertical/email//messages).
    { name: 'providers/email', source: 'src/providers/email.ts' },
    { name: 'providers/slack', source: 'src/providers/slack.ts' },
    { name: 'providers/twitter', source: 'src/providers/twitter.ts' },
    { name: 'providers/all', source: 'src/providers/all.ts' },
  ],
  svelte: 'svelte',
});

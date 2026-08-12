import { ASSETS_ROUTE_MODULE } from './route-module.js';
import playground from './svelte/playground.js';

const routeModule = {
  ...ASSETS_ROUTE_MODULE,
  routes: {
    manager: ASSETS_ROUTE_MODULE.routes.manager,
  },
};

export default {
  packageName: '@happyvertical/smrt-assets',
  displayName: 'Assets',
  description:
    'Workbench surfaces for asset browsing, selection, organization, and package previews.',
  routeModules: [routeModule],
  recommendedCommands: [
    {
      id: 'assets:test',
      label: 'Test',
      command: 'pnpm --filter @happyvertical/smrt-assets test',
    },
    {
      id: 'assets:typecheck',
      label: 'Typecheck',
      command: 'pnpm --filter @happyvertical/smrt-assets typecheck',
    },
  ],
  examples: [
    {
      id: 'assets:playground',
      title: 'Assets playground module',
      path: 'src/svelte/playground.ts',
      source: 'playground',
    },
  ],
};

export { playground };

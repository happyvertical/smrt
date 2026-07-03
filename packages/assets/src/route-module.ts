import type {
  SmrtRouteDefinition,
  SmrtRouteModule,
} from '@happyvertical/smrt-types';
import { AssetManagerRoute } from './svelte/routes/index.js';
import {
  ASSETS_DEFAULT_ROUTE_NAVIGATION,
  ASSETS_ROUTE_IDS,
  ASSETS_ROUTE_META,
  type AssetsRouteId,
  type AssetsRouteNavigationItem,
  createAssetsRouteNavigation,
} from './svelte/routes/shared.js';

export type { AssetsRouteId, AssetsRouteNavigationItem };
export {
  ASSETS_DEFAULT_ROUTE_NAVIGATION,
  ASSETS_ROUTE_IDS,
  ASSETS_ROUTE_META,
  AssetManagerRoute,
  createAssetsRouteNavigation,
};

export interface AssetsRouteDefinitions {
  manager: SmrtRouteDefinition;
}

export type AssetsRouteModule = Omit<SmrtRouteModule, 'routes'> & {
  routes: AssetsRouteDefinitions;
};

export const ASSETS_ROUTE_MODULE: AssetsRouteModule = {
  packageName: '@happyvertical/smrt-assets',
  displayName: 'Assets',
  description:
    'Package-owned route surface for browsing, selecting, and organizing assets.',
  routes: {
    manager: {
      ...ASSETS_ROUTE_META.manager,
      component: AssetManagerRoute,
      tags: ['assets', 'media', 'admin'],
    },
  },
};

export default ASSETS_ROUTE_MODULE;

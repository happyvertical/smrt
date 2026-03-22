import type {
  SmrtRouteDefinition,
  SmrtRouteModule,
} from '@happyvertical/smrt-types';
import { ImageStudioRoute } from './svelte/routes/index.js';
import {
  createImagesRouteNavigation,
  IMAGES_DEFAULT_ROUTE_NAVIGATION,
  IMAGES_ROUTE_IDS,
  IMAGES_ROUTE_META,
  type ImagesRouteId,
  type ImagesRouteNavigationItem,
} from './svelte/routes/shared.js';

export { ImageStudioRoute };
export {
  IMAGES_DEFAULT_ROUTE_NAVIGATION,
  IMAGES_ROUTE_IDS,
  IMAGES_ROUTE_META,
  createImagesRouteNavigation,
};
export type { ImagesRouteId, ImagesRouteNavigationItem };

export interface ImagesRouteDefinitions {
  studio: SmrtRouteDefinition;
}

export type ImagesRouteModule = Omit<SmrtRouteModule, 'routes'> & {
  routes: ImagesRouteDefinitions;
};

export const IMAGES_ROUTE_MODULE: ImagesRouteModule = {
  packageName: '@happyvertical/smrt-images',
  displayName: 'Images',
  description:
    'Package-owned route surface for image acquisition, browsing, and editing.',
  routes: {
    studio: {
      ...IMAGES_ROUTE_META.studio,
      component: ImageStudioRoute,
      tags: ['images', 'media', 'admin'],
    },
  },
};

export default IMAGES_ROUTE_MODULE;

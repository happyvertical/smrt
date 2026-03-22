import type {
  SmrtRouteDefinition,
  SmrtRouteNavigationItem,
} from '@happyvertical/smrt-types';

export const IMAGES_ROUTE_IDS = {
  studio: '@happyvertical/smrt-images:studio',
} as const;

export type ImagesRouteId =
  (typeof IMAGES_ROUTE_IDS)[keyof typeof IMAGES_ROUTE_IDS];

export type ImagesRouteNavigationItem = SmrtRouteNavigationItem;

export const IMAGES_ROUTE_META = {
  studio: {
    id: IMAGES_ROUTE_IDS.studio,
    title: 'Image Studio',
    description:
      'Browse images, run uploads, and hand off selected assets into the package-owned image editor surface.',
    defaultPath: '/images',
    loadKind: undefined,
    nav: {
      label: 'Images',
      description: 'Browse image assets and open the image editor.',
      icon: 'image',
      order: 20,
      group: 'content',
    },
  } satisfies Omit<SmrtRouteDefinition, 'component'>,
} as const;

export function createImagesRouteNavigation(
  mounts: Partial<Record<ImagesRouteId, string>> = {},
): ImagesRouteNavigationItem[] {
  return [IMAGES_ROUTE_META.studio].map((route) => ({
    routeId: route.id,
    href: mounts[route.id] ?? route.defaultPath,
    label: route.nav?.label ?? route.title,
    description: route.nav?.description ?? route.description,
    icon: route.nav?.icon,
    order: route.nav?.order,
    group: route.nav?.group,
  }));
}

export const IMAGES_DEFAULT_ROUTE_NAVIGATION = createImagesRouteNavigation();

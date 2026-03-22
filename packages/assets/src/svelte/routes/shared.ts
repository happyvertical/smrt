import type {
  SmrtRouteDefinition,
  SmrtRouteNavigationItem,
} from '@happyvertical/smrt-types';

export const ASSETS_ROUTE_IDS = {
  manager: '@happyvertical/smrt-assets:manager',
} as const;

export type AssetsRouteId =
  (typeof ASSETS_ROUTE_IDS)[keyof typeof ASSETS_ROUTE_IDS];

export type AssetsRouteNavigationItem = SmrtRouteNavigationItem;

export const ASSETS_ROUTE_META = {
  manager: {
    id: ASSETS_ROUTE_IDS.manager,
    title: 'Asset Manager',
    description:
      'Manage uploads, browse the asset library, and review selection state from the package-owned asset management route.',
    defaultPath: '/assets',
    loadKind: undefined,
    nav: {
      label: 'Assets',
      description: 'Manage uploaded media and reusable files.',
      icon: 'folder-image',
      order: 10,
      group: 'content',
    },
  } satisfies Omit<SmrtRouteDefinition, 'component'>,
} as const;

export function createAssetsRouteNavigation(
  mounts: Partial<Record<AssetsRouteId, string>> = {},
): AssetsRouteNavigationItem[] {
  return [ASSETS_ROUTE_META.manager].map((route) => ({
    routeId: route.id,
    href: mounts[route.id] ?? route.defaultPath,
    label: route.nav?.label ?? route.title,
    description: route.nav?.description ?? route.description,
    icon: route.nav?.icon,
    order: route.nav?.order,
    group: route.nav?.group,
  }));
}

export const ASSETS_DEFAULT_ROUTE_NAVIGATION = createAssetsRouteNavigation();

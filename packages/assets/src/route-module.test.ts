import { describe, expect, it } from 'vitest';
import {
  ASSETS_DEFAULT_ROUTE_NAVIGATION,
  ASSETS_ROUTE_IDS,
  ASSETS_ROUTE_MODULE,
  createAssetsRouteNavigation,
} from './route-module.js';

describe('assets route module', () => {
  it('exports a stable package-owned asset manager route', () => {
    expect(ASSETS_ROUTE_MODULE.packageName).toBe('@happyvertical/smrt-assets');
    expect(Object.keys(ASSETS_ROUTE_MODULE.routes)).toEqual(['manager']);
    expect(ASSETS_ROUTE_MODULE.routes.manager.defaultPath).toBe('/assets');
    expect(ASSETS_ROUTE_MODULE.routes.manager.nav?.label).toBe('Assets');
  });

  it('builds navigation with overrideable mount paths', () => {
    expect(ASSETS_DEFAULT_ROUTE_NAVIGATION).toEqual([
      expect.objectContaining({
        routeId: ASSETS_ROUTE_IDS.manager,
        href: '/assets',
        label: 'Assets',
      }),
    ]);

    expect(
      createAssetsRouteNavigation({
        [ASSETS_ROUTE_IDS.manager]: '/[siteSlug]/media',
      }),
    ).toEqual([
      expect.objectContaining({
        routeId: ASSETS_ROUTE_IDS.manager,
        href: '/[siteSlug]/media',
      }),
    ]);
  });
});

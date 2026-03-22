import { describe, expect, it } from 'vitest';
import {
  createImagesRouteNavigation,
  IMAGES_DEFAULT_ROUTE_NAVIGATION,
  IMAGES_ROUTE_IDS,
  IMAGES_ROUTE_MODULE,
} from './route-module.js';

describe('images route module', () => {
  it('exports a stable package-owned image studio route', () => {
    expect(IMAGES_ROUTE_MODULE.packageName).toBe('@happyvertical/smrt-images');
    expect(Object.keys(IMAGES_ROUTE_MODULE.routes)).toEqual(['studio']);
    expect(IMAGES_ROUTE_MODULE.routes.studio.defaultPath).toBe('/images');
    expect(IMAGES_ROUTE_MODULE.routes.studio.nav?.label).toBe('Images');
  });

  it('builds navigation with overrideable mount paths', () => {
    expect(IMAGES_DEFAULT_ROUTE_NAVIGATION).toEqual([
      expect.objectContaining({
        routeId: IMAGES_ROUTE_IDS.studio,
        href: '/images',
        label: 'Images',
      }),
    ]);

    expect(
      createImagesRouteNavigation({
        [IMAGES_ROUTE_IDS.studio]: '/[siteSlug]/media/images',
      }),
    ).toEqual([
      expect.objectContaining({
        routeId: IMAGES_ROUTE_IDS.studio,
        href: '/[siteSlug]/media/images',
      }),
    ]);
  });
});

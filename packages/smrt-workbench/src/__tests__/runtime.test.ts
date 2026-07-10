import { describe, expect, it } from 'vitest';
import {
  coerceWorkbenchModules,
  mergeWorkbenchModules,
  normalizeWorkbenchModule,
  qualifyWorkbenchRouteId,
} from '../runtime.js';

describe('@happyvertical/smrt-workbench runtime', () => {
  it('coerces module exports to module arrays', () => {
    const module = {
      packageName: '@happyvertical/smrt-content',
      routeModules: [],
    };

    expect(coerceWorkbenchModules(module)).toEqual([module]);
    expect(coerceWorkbenchModules({ modules: [module] })).toEqual([module]);
  });

  it('normalizes route modules into qualified inline route entries', () => {
    const normalized = normalizeWorkbenchModule({
      packageName: '@happyvertical/smrt-content',
      routeModules: [
        {
          packageName: '@happyvertical/smrt-content',
          displayName: 'Content',
          routes: {
            workspace: {
              id: 'content.workspace',
              title: 'Workspace',
              defaultPath: '/workspace',
            },
          },
        },
      ],
    });

    expect(normalized.displayName).toBe('Content');
    expect(normalized.routes).toHaveLength(1);
    expect(normalized.routes[0]?.qualifiedId).toBe(
      '@happyvertical/smrt-content:content.workspace',
    );
  });

  it('merges modules by package name', () => {
    const merged = mergeWorkbenchModules([
      {
        packageName: '@happyvertical/smrt-content',
        routeModules: [
          {
            packageName: '@happyvertical/smrt-content',
            routes: {
              one: { id: 'one', title: 'One', defaultPath: '/one' },
            },
          },
        ],
      },
      {
        packageName: '@happyvertical/smrt-content',
        routeModules: [
          {
            packageName: '@happyvertical/smrt-content',
            routes: {
              two: { id: 'two', title: 'Two', defaultPath: '/two' },
            },
          },
        ],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.routes.map((route) => route.id)).toEqual(['one', 'two']);
  });

  it('merges singular route modules without duplicating the later route', () => {
    const merged = mergeWorkbenchModules([
      {
        packageName: '@happyvertical/smrt-content',
        routeModule: {
          packageName: '@happyvertical/smrt-content',
          routes: {
            one: { id: 'one', title: 'One', defaultPath: '/one' },
          },
        },
      },
      {
        packageName: '@happyvertical/smrt-content',
        routeModule: {
          packageName: '@happyvertical/smrt-content',
          routes: {
            two: { id: 'two', title: 'Two', defaultPath: '/two' },
          },
        },
      },
    ]);

    expect(merged[0]?.routes.map((route) => route.id)).toEqual(['one', 'two']);
  });
});

describe('qualifyWorkbenchRouteId', () => {
  it('prefixes route ids with the package name', () => {
    expect(
      qualifyWorkbenchRouteId('@happyvertical/smrt-assets', 'manager'),
    ).toBe('@happyvertical/smrt-assets:manager');
  });
});

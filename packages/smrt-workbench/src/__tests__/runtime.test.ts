import { describe, expect, it } from 'vitest';
import {
  coerceWorkbenchModules,
  findWorkbenchRouteByHash,
  mergeWorkbenchModules,
  normalizeWorkbenchModule,
  qualifyWorkbenchRouteId,
  workbenchRouteHash,
} from '../runtime.js';
import { workbenchScriptCommand } from '../svelte/command.js';

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

describe('Workbench route fragments', () => {
  it('maps embedded route hashes back to normalized host routes', () => {
    const routes = normalizeWorkbenchModule({
      packageName: '@happyvertical/smrt-content',
      routeModules: [
        {
          packageName: '@happyvertical/smrt-content',
          routes: {
            workspace: {
              id: 'content.workspace',
              title: 'Contents',
              defaultPath: '/workspace',
            },
          },
        },
      ],
    }).routes;

    expect(workbenchRouteHash('content.workspace')).toBe('#content-workspace');
    expect(
      findWorkbenchRouteByHash(routes, '#content-workspace')?.qualifiedId,
    ).toBe('@happyvertical/smrt-content:content.workspace');
    expect(findWorkbenchRouteByHash(routes, '#missing')).toBeNull();
  });
});

describe('workbenchScriptCommand', () => {
  it('formats workspace and consumer commands for their package manager', () => {
    expect(
      workbenchScriptCommand(
        { name: '@happyvertical/smrt-content', source: 'workspace' },
        'test',
        'pnpm',
      ),
    ).toBe('pnpm --filter @happyvertical/smrt-content test');
    expect(
      workbenchScriptCommand(
        { name: 'consumer-app', source: 'app' },
        'test',
        'npm',
      ),
    ).toBe('npm run test');
    expect(
      workbenchScriptCommand(
        { name: 'consumer-app', source: 'app' },
        'check',
        'yarn',
      ),
    ).toBe('yarn run check');
    expect(
      workbenchScriptCommand(
        {
          name: '@happyvertical/smrt-content',
          source: 'package',
          relativeDirectory: 'node_modules/@happyvertical/smrt-content',
        },
        'typecheck',
        'pnpm',
      ),
    ).toBe('pnpm --dir node_modules/@happyvertical/smrt-content run typecheck');
  });
});

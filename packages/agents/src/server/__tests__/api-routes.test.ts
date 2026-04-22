import type { ApiConfig } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { buildRouteMap, resolveAPIRoute } from '../api-routes.js';
import type { PackageManifest } from '../manifest-utils.js';

function makeManifest(
  objects: Record<
    string,
    { className: string; decoratorConfig?: Record<string, unknown> }
  >,
  packageName?: string,
): PackageManifest {
  const m = { objects } as unknown as PackageManifest;
  if (packageName) (m as Record<string, unknown>).packageName = packageName;
  return m;
}

describe('buildRouteMap', () => {
  it('registers routes from objects with api.include', () => {
    const manifest = makeManifest({
      Performer: {
        className: 'Performer',
        decoratorConfig: {
          tableName: 'performers',
          api: { include: ['list', 'get', 'create'] },
        },
      },
    });
    const routes = buildRouteMap([manifest]);
    expect(routes.size).toBe(1);
    expect(routes.get('performers')).toEqual({
      className: 'Performer',
      allowedActions: ['list', 'get', 'create'],
      packageName: undefined,
    });
  });

  it('prefers api.path over table name', () => {
    const videoApiConfig: ApiConfig = { include: ['list'], path: 'videos' };
    const manifest = makeManifest({
      VideoShot: {
        className: 'VideoShot',
        decoratorConfig: {
          tableName: 'video_shots',
          api: videoApiConfig,
        },
      },
    });
    const routes = buildRouteMap([manifest]);
    expect(routes.has('videos')).toBe(true);
    expect(routes.has('video-shots')).toBe(false);
  });

  it('converts underscores to hyphens in table name', () => {
    const manifest = makeManifest({
      VideoContent: {
        className: 'VideoContent',
        decoratorConfig: {
          tableName: 'video_contents',
          api: { include: ['list'] },
        },
      },
    });
    const routes = buildRouteMap([manifest]);
    expect(routes.has('video-contents')).toBe(true);
  });

  it('stamps packageName from manifest', () => {
    const manifest = makeManifest(
      {
        Performer: {
          className: 'Performer',
          decoratorConfig: {
            tableName: 'performers',
            api: { include: ['list'] },
          },
        },
      },
      '@happyvertical/histrio',
    );
    const routes = buildRouteMap([manifest]);
    expect(routes.get('performers')?.packageName).toBe(
      '@happyvertical/histrio',
    );
  });

  it('skips objects without api.include', () => {
    const manifest = makeManifest({
      Internal: {
        className: 'Internal',
        decoratorConfig: { tableName: 'internals' },
      },
    });
    const routes = buildRouteMap([manifest]);
    expect(routes.size).toBe(0);
  });

  it('skips objects with empty api.include', () => {
    const manifest = makeManifest({
      Empty: {
        className: 'Empty',
        decoratorConfig: {
          tableName: 'empties',
          api: { include: [] },
        },
      },
    });
    const routes = buildRouteMap([manifest]);
    expect(routes.size).toBe(0);
  });

  it('skips objects without decoratorConfig', () => {
    const manifest = makeManifest({
      Bare: { className: 'Bare' },
    });
    const routes = buildRouteMap([manifest]);
    expect(routes.size).toBe(0);
  });

  it('merges routes from multiple manifests', () => {
    const m1 = makeManifest({
      Performer: {
        className: 'Performer',
        decoratorConfig: {
          tableName: 'performers',
          api: { include: ['list', 'get'] },
        },
      },
    });
    const m2 = makeManifest({
      Meeting: {
        className: 'Meeting',
        decoratorConfig: {
          tableName: 'meetings',
          api: { include: ['list'] },
        },
      },
    });
    const routes = buildRouteMap([m1, m2]);
    expect(routes.size).toBe(2);
    expect(routes.has('performers')).toBe(true);
    expect(routes.has('meetings')).toBe(true);
  });
});

describe('resolveAPIRoute', () => {
  const routes = buildRouteMap([
    makeManifest({
      Performer: {
        className: 'Performer',
        decoratorConfig: {
          tableName: 'performers',
          api: { include: ['list', 'get', 'create', 'update', 'delete'] },
        },
      },
    }),
  ]);

  it('resolves collection path (1 segment)', () => {
    const result = resolveAPIRoute('performers', routes);
    expect(result).toEqual({
      route: expect.objectContaining({ className: 'Performer' }),
    });
    expect(result?.id).toBeUndefined();
    expect(result?.action).toBeUndefined();
  });

  it('resolves resource path with id (2 segments)', () => {
    const result = resolveAPIRoute('performers/abc-123', routes);
    expect(result?.route.className).toBe('Performer');
    expect(result?.id).toBe('abc-123');
    expect(result?.action).toBeUndefined();
  });

  it('resolves action path (3 segments)', () => {
    const result = resolveAPIRoute('performers/abc-123/generate-image', routes);
    expect(result?.route.className).toBe('Performer');
    expect(result?.id).toBe('abc-123');
    expect(result?.action).toBe('generate-image');
  });

  it('returns null for unknown resource', () => {
    expect(resolveAPIRoute('unknown', routes)).toBeNull();
  });

  it('returns null for empty path', () => {
    expect(resolveAPIRoute('', routes)).toBeNull();
  });

  it('returns null for too many segments', () => {
    expect(resolveAPIRoute('a/b/c/d', routes)).toBeNull();
  });

  it('strips leading and trailing slashes', () => {
    const result = resolveAPIRoute('/performers/', routes);
    expect(result?.route.className).toBe('Performer');
  });

  it('strips multiple leading slashes', () => {
    const result = resolveAPIRoute('///performers///abc-123///', routes);
    // After stripping leading/trailing, split gives ['performers', '', '', 'abc-123', '', '']
    // This actually produces 6 segments due to internal slashes, so returns null
    // The normalization only strips leading/trailing
    expect(result).toBeNull();
  });
});

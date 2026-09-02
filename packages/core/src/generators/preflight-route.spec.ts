/**
 * Browser-plane preflight route (#2590).
 *
 * The load-bearing assertion in this file is the negative one: `authMiddleware`
 * is never invoked by preflight. It is enforced structurally — the route's
 * options carry no auth handle at all — and asserted here against a spy that a
 * sibling CRUD request does trip, so the spy is proven live.
 */

import { describe, expect, it, vi } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import {
  handlePlaybookPreflightRoute,
  isApiActionEnabledForObject,
  isRestActionRoutable,
  isRestRoutePublic,
  PLAYBOOK_PREFLIGHT_CAPABILITY,
  resolveRegisteredObjectName,
  restFieldReadPermissions,
  restMethodForApiAction,
} from './preflight-route';
import { APIGenerator } from './rest';

@smrt({ api: { public: 'read', exclude: ['delete'] } })
class PreflightWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text', readPermission: 'widgets.internal.read' })
  internalNote: string = '';
}

@smrt({ api: { public: false } })
class PreflightPrivateWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

@smrt({
  api: {
    public: 'read',
    routes: {
      summarize: { method: 'GET' },
      publish: { method: 'POST' },
    },
  },
})
class PreflightRoutedWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

// The classes are referenced so the decorators run under tree-shaking.
void PreflightWidget;
void PreflightPrivateWidget;
void PreflightRoutedWidget;

const UNIFORM_UNAVAILABLE = {
  available: false,
  advisory: true,
  verdict: 'deny',
  steps: [],
  summary: { allow: 0, deny: 0, unknown: 0 },
};

function request(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

describe('playbook preflight route (#2590)', () => {
  it('is classified as a read, idempotent, closed-world capability', () => {
    expect(PLAYBOOK_PREFLIGHT_CAPABILITY).toEqual({
      effect: 'read',
      idempotent: true,
      openWorld: false,
    });
  });

  it('serves the provider report for a GET with a key', async () => {
    const provider = vi.fn(async () => UNIFORM_UNAVAILABLE);
    const response = await handlePlaybookPreflightRoute(
      request('http://local/api/v1/_preflight?key=commerce.cart.checkout'),
      { provider, appAuthConfigured: false },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(await response.json()).toEqual(UNIFORM_UNAVAILABLE);
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'commerce.cart.checkout',
        plane: 'browser',
        appAuthConfigured: false,
      }),
    );
  });

  it('passes only the boolean appAuthConfigured — never an auth handle', async () => {
    const provider = vi.fn(async () => UNIFORM_UNAVAILABLE);
    await handlePlaybookPreflightRoute(
      request('http://local/api/v1/_preflight?key=k'),
      { provider, appAuthConfigured: true, permissions: ['widgets.read'] },
    );

    const [payload] = provider.mock.calls[0] as [Record<string, unknown>];
    expect(payload.appAuthConfigured).toBe(true);
    for (const value of Object.values(payload)) {
      expect(typeof value).not.toBe('function');
    }
  });

  it('404s when no provider is wired, saying nothing about any key', async () => {
    const response = await handlePlaybookPreflightRoute(
      request('http://local/api/v1/_preflight?key=k'),
      { appAuthConfigured: false },
    );
    expect(response.status).toBe(404);
  });

  it('rejects a non-GET: preflight is a read', async () => {
    const response = await handlePlaybookPreflightRoute(
      request('http://local/api/v1/_preflight?key=k', { method: 'POST' }),
      { provider: async () => UNIFORM_UNAVAILABLE, appAuthConfigured: false },
    );
    expect(response.status).toBe(405);
  });

  it('requires a key', async () => {
    const response = await handlePlaybookPreflightRoute(
      request('http://local/api/v1/_preflight'),
      { provider: async () => UNIFORM_UNAVAILABLE, appAuthConfigured: false },
    );
    expect(response.status).toBe(400);
  });

  describe('never invokes authMiddleware', () => {
    function generator(authMiddleware: ReturnType<typeof vi.fn>) {
      const api = new APIGenerator(
        {
          basePath: '/api/v1',
          authMiddleware: authMiddleware as unknown as (
            objectName: string,
            action: string,
          ) => (req: Request) => Promise<Request | Response>,
          playbookPreflight: async () => UNIFORM_UNAVAILABLE,
        },
        { permissions: ['widgets.read'] },
      );
      return api.generateHandler();
    }

    it('leaves the middleware untouched for a preflight request', async () => {
      const authMiddleware = vi.fn(() => async (req: Request) => req);
      const handler = generator(authMiddleware);

      const response = await handler(
        request('http://local/api/v1/_preflight?key=commerce.cart.checkout'),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(UNIFORM_UNAVAILABLE);
      // Not "not called with these arguments" — never called at all.
      expect(authMiddleware).not.toHaveBeenCalled();
    });

    it('proves the spy is live: an ordinary route does invoke it', async () => {
      const authMiddleware = vi.fn(() => async (req: Request) => req);
      const handler = generator(authMiddleware);

      // Only the auth call matters here; the request dies afterwards because no
      // collection is registered for this spec, which is irrelevant to the
      // claim being proven.
      await handler(request('http://local/api/v1/preflightwidgets')).catch(
        () => undefined,
      );

      expect(authMiddleware).toHaveBeenCalled();
    });

    it('still reports appAuthConfigured so the app-auth layer can say unknown', async () => {
      const provider = vi.fn(async () => UNIFORM_UNAVAILABLE);
      const api = new APIGenerator({
        basePath: '/api/v1',
        authMiddleware: vi.fn(() => async (req: Request) => req) as never,
        playbookPreflight: provider,
      });
      await api.generateHandler()(
        request('http://local/api/v1/_preflight?key=k'),
      );

      expect(provider).toHaveBeenCalledWith(
        expect.objectContaining({ appAuthConfigured: true }),
      );
    });
  });

  describe('static layer facts', () => {
    it('resolves a qualified model reference to its registered object name', () => {
      const registered = ObjectRegistry.getClass('PreflightWidget');
      expect(registered).toBeDefined();
      expect(resolveRegisteredObjectName('PreflightWidget')).toBe(
        'PreflightWidget',
      );
      expect(
        resolveRegisteredObjectName('@happyvertical/nope:Missing'),
      ).toBeUndefined();
    });

    it('reads the decorator action gate, including custom action names', () => {
      expect(isApiActionEnabledForObject('PreflightWidget', 'list')).toBe(true);
      expect(isApiActionEnabledForObject('PreflightWidget', 'delete')).toBe(
        false,
      );
    });

    it('reads the fail-closed public posture per HTTP method', () => {
      expect(isRestRoutePublic('PreflightWidget', 'GET')).toBe(true);
      expect(isRestRoutePublic('PreflightWidget', 'POST')).toBe(false);
      expect(isRestRoutePublic('PreflightPrivateWidget', 'GET')).toBe(false);
      expect(isRestRoutePublic(undefined, 'GET')).toBe(false);
    });

    it('maps CRUD actions to their fixed verbs', () => {
      expect(restMethodForApiAction('list')).toBe('GET');
      expect(restMethodForApiAction('get')).toBe('GET');
      expect(restMethodForApiAction('create')).toBe('POST');
      expect(restMethodForApiAction('update')).toBe('PUT');
      expect(restMethodForApiAction('delete')).toBe('DELETE');
    });

    it('reads a custom action’s declared verb, and falls back to POST', () => {
      // A declared GET custom action on a `public: 'read'` model IS publicly
      // served; guessing POST here would report a false deny and hide a
      // playbook the caller can actually run.
      expect(restMethodForApiAction('summarize', 'PreflightRoutedWidget')).toBe(
        'GET',
      );
      expect(restMethodForApiAction('publish', 'PreflightRoutedWidget')).toBe(
        'POST',
      );
      // Without an object name to read the declaration from, fail closed.
      expect(restMethodForApiAction('summarize')).toBe('POST');
    });

    it('predicts public access for a declared GET custom action', () => {
      expect(
        isRestRoutePublic(
          'PreflightRoutedWidget',
          restMethodForApiAction('summarize', 'PreflightRoutedWidget'),
        ),
      ).toBe(true);
      expect(
        isRestRoutePublic(
          'PreflightRoutedWidget',
          restMethodForApiAction('publish', 'PreflightRoutedWidget'),
        ),
      ).toBe(false);
    });

    it('treats only CRUD and declared custom routes as dispatchable', () => {
      // `include`/`exclude` gate exposure; they do not conjure a route. The
      // runtime dispatcher iterates `api.routes` alone, so an undeclared custom
      // action can never execute — and preflight must not report it as `allow`
      // and let an agent start the earlier steps of a non-atomic playbook.
      expect(isRestActionRoutable('PreflightRoutedWidget', 'list')).toBe(true);
      expect(isRestActionRoutable('PreflightRoutedWidget', 'summarize')).toBe(
        true,
      );
      expect(isRestActionRoutable('PreflightRoutedWidget', 'summarise')).toBe(
        false,
      );
      // A model declaring no custom routes at all has none.
      expect(isRestActionRoutable('PreflightWidget', 'summarize')).toBe(false);
      expect(isRestActionRoutable(undefined, 'list')).toBe(false);
    });

    it('collects the model field read-permission slugs', () => {
      expect(restFieldReadPermissions('PreflightWidget')).toEqual([
        'widgets.internal.read',
      ]);
      expect(restFieldReadPermissions('PreflightPrivateWidget')).toEqual([]);
      expect(restFieldReadPermissions(undefined)).toEqual([]);
    });
  });
});

/**
 * Browser-plane preflight wiring for the generated REST surface (issue #2590).
 *
 * Binds the plane-agnostic evaluator in `preflight.ts` to the static layers
 * `@happyvertical/smrt-core` exposes, and produces the provider the generated
 * `_preflight` route takes as a seam. Core owns the route and the layer facts;
 * this package owns resolution and the verdict vocabulary, so the dependency
 * stays one-way (playbooks → core).
 *
 * Nothing here can reach `authMiddleware`: the provider is handed a boolean
 * `appAuthConfigured` and no auth handle at all.
 */

import {
  isApiActionEnabledForObject,
  isRestRoutePublic,
  resolveRegisteredObjectName,
  restFieldReadPermissions,
  restMethodForApiAction,
} from '@happyvertical/smrt-core';
import { createBrowserStepEvaluator, preflightPlaybook } from './preflight.js';
import type {
  BrowserPreflightLayerSource,
  PlaybookPreflightReport,
} from './preflight-types.js';
import type { ResolvePlaybookOptions } from './types.js';

/**
 * A layer source reading the generated REST surface's own static rules.
 *
 * A model this build does not register resolves to no object name, and every
 * layer then fails closed: an unregistered model has no route, so a step naming
 * one can only die.
 */
export function createRestPreflightLayerSource(options: {
  appAuthConfigured: boolean;
}): BrowserPreflightLayerSource {
  return {
    appAuthConfigured: options.appAuthConfigured,
    isActionExposed(model, action) {
      const objectName = resolveRegisteredObjectName(model);
      if (!objectName) return false;
      return isApiActionEnabledForObject(objectName, action);
    },
    isRoutePublic(model, action) {
      const objectName = resolveRegisteredObjectName(model);
      if (!objectName) return false;
      // The object name is threaded through so a custom action declaring its
      // own HTTP verb is predicted against that verb, not a guessed POST.
      return isRestRoutePublic(
        objectName,
        restMethodForApiAction(action, objectName),
      );
    },
    requiredFieldPermissions(model) {
      const objectName = resolveRegisteredObjectName(model);
      if (!objectName) return [];
      return restFieldReadPermissions(objectName);
    },
  };
}

export interface BrowserPreflightProviderOptions {
  /**
   * Resolution options shared by every request — classifier, intent registry,
   * and any host-level runtime override. The per-request database handle and
   * tenant come from the route.
   */
  resolve?: Omit<ResolvePlaybookOptions, 'plane' | 'db'>;
  /**
   * Derives the cache-partitioning principal identity for a request. Opaque and
   * never echoed; defaults to the caller's permission slugs, which is the only
   * caller-distinguishing input the static layers actually read.
   */
  principal?: (request: {
    permissions?: Iterable<string>;
    appAuthConfigured: boolean;
  }) => string;
}

function defaultPrincipal(request: { permissions?: Iterable<string> }): string {
  const slugs = request.permissions ? [...request.permissions].sort() : [];
  return `perm:${slugs.join(',')}`;
}

/**
 * Builds the provider wired into `APIConfig.playbookPreflight`.
 *
 * ```typescript
 * const api = new APIGenerator(manifest, {
 *   playbookPreflight: createBrowserPlaybookPreflight(),
 * });
 * ```
 *
 * Every unresolvable key — unknown, disabled, browser-invalid, unresolvable
 * intent — comes back as the single uniform unavailable report, so the endpoint
 * is not an enumeration oracle.
 */
export function createBrowserPlaybookPreflight(
  options: BrowserPreflightProviderOptions = {},
): (request: {
  key: string;
  plane: 'browser';
  permissions?: Iterable<string>;
  appAuthConfigured: boolean;
  db?: unknown;
}) => Promise<PlaybookPreflightReport> {
  return async (request) => {
    const layers = createRestPreflightLayerSource({
      appAuthConfigured: request.appAuthConfigured,
    });
    return preflightPlaybook({
      key: request.key,
      plane: 'browser',
      principal: (options.principal ?? defaultPrincipal)(request),
      resolve: {
        ...options.resolve,
        ...(request.db === undefined
          ? {}
          : { db: request.db as ResolvePlaybookOptions['db'] }),
      },
      evaluate: createBrowserStepEvaluator({
        layers,
        permissions: request.permissions ?? null,
      }),
    });
  };
}

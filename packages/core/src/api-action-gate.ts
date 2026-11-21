/**
 * The `@smrt({ api })` action gate, in a leaf module so code outside the REST
 * generator (the change-feed default table policy, #5446) reads the same rule
 * without loading the generator's Node-only dependencies.
 * `generators/preflight-route.ts` re-exports it.
 */

import { ObjectRegistry } from './registry.js';

/**
 * Whether `@smrt({ api })` exposes `action` on `objectName`.
 *
 * The generator's own action gate, lifted to a module function so preflight and
 * the live route read the same rule from one place. Accepts any action name so
 * a custom action is gated by the same `include`/`exclude` lists.
 *
 * @remarks An absent `objectName` returns `true` — fail-**open**, because the
 * live route reaches this only after it has already resolved a model, and an
 * unnamed object there means "not gated by this rule". A caller *predicting*
 * rather than serving has no such guarantee and must reject an unresolvable
 * model before asking (see `createRestPreflightLayerSource`).
 */
export function isApiActionEnabledForObject(
  objectName: string | undefined,
  action: string,
): boolean {
  if (!objectName) {
    return true;
  }

  const config = ObjectRegistry.getConfig(objectName);
  if (config.abstract && action !== 'list' && action !== 'get') {
    return false;
  }
  const apiConfig = config.api;

  if (apiConfig === false) {
    return false;
  }

  if (apiConfig && typeof apiConfig === 'object') {
    if (apiConfig.include && !apiConfig.include.includes(action)) {
      return false;
    }

    if (apiConfig.exclude?.includes(action)) {
      return false;
    }
  }

  return true;
}

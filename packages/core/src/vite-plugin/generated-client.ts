/**
 * Shared runtime generator for producer and consumer `@smrt/client` modules.
 *
 * Keep runtime values on the same manifest-derived contract as physical and
 * virtual declarations. In particular, disabled objects, partial CRUD
 * allowlists, stable collection keys, and custom route signatures must not
 * diverge between the two plugin entry points.
 */

import { CLIENT_FETCH_RUNTIME } from '../generated-client-runtime.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { selectApiClientEntries } from './api-client-entries.js';
import { resolveApiActionRouteConfig } from './sveltekit-generator.js';
import { isCollectionManifestClass } from './web-collections.js';

export const GENERATED_CLIENT_CRUD_METHODS = new Set([
  'list',
  'get',
  'create',
  'update',
  'delete',
]);

export const GENERATED_CLIENT_BASE_METHODS = new Set([
  ...GENERATED_CLIENT_CRUD_METHODS,
  'search',
]);

export function generateClientModule(
  manifest: SmartObjectManifest,
  options: { kebabRoutes?: boolean } = {},
): string {
  const objects = selectApiClientEntries(manifest);

  const clientMethods = objects
    .map(({ obj, clientKey, crudMethods, customMethods: exposedMethods }) => {
      const { collection, methods = {} } = obj;

      const exposedActionNames = new Set(
        exposedMethods.map((method) => method.name),
      );
      const apiConfig = obj.decoratorConfig?.api;
      const customMethods = Object.entries(methods).filter(
        ([name, method]) =>
          !GENERATED_CLIENT_CRUD_METHODS.has(name) &&
          method.isPublic &&
          exposedActionNames.has(name),
      );

      const customMethodImpls = customMethods
        .map(([methodName, method]) => {
          const routeConfig = resolveApiActionRouteConfig(
            methodName,
            method,
            apiConfig,
            { kebabRoutes: options.kebabRoutes },
            isCollectionManifestClass(manifest, obj)
              ? 'collection'
              : method.isStatic
                ? 'collection'
                : 'item',
          );
          const urlSegment = routeConfig.pathSegments.join('/');
          const args =
            routeConfig.scope === 'collection' ? 'options' : 'id, options';
          const route =
            routeConfig.scope === 'collection'
              ? `basePath + '/${collection}/${urlSegment}'`
              : `basePath + '/${collection}/' + id + '/${urlSegment}'`;
          const actionUrl = `__smrtActionUrl(${route}, options, ${JSON.stringify(
            routeConfig.pathParamNames,
          )}, ${routeConfig.method === 'GET'})`;
          const requestInit =
            routeConfig.method === 'GET'
              ? `{
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }`
              : `{
      method: '${routeConfig.method}',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {})
    }`;
          return `    ${methodName}: (${args}) => __smrtFetchActionResult(${actionUrl}, ${requestInit})`;
        })
        .join(',\n');

      const enabledCrudMethods = new Set(crudMethods);
      const crudMethodImpls = [
        enabledCrudMethods.has('list')
          ? `    list: (params) => __smrtFetchJson(basePath + '/${collection}', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })`
          : '',
        enabledCrudMethods.has('get')
          ? `    get: (id) => __smrtFetchJson(basePath + '/${collection}/' + id, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })`
          : '',
        enabledCrudMethods.has('create')
          ? `    create: (data) => __smrtFetchJson(basePath + '/${collection}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })`
          : '',
        enabledCrudMethods.has('update')
          ? `    update: (id, data) => __smrtFetchJson(basePath + '/${collection}/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })`
          : '',
        enabledCrudMethods.has('delete')
          ? `    delete: (id) => __smrtFetchOk(basePath + '/${collection}/' + id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    })`
          : '',
        enabledCrudMethods.has('search')
          ? `    search: (query) => __smrtFetchJson(basePath + '/${collection}/search?q=' + encodeURIComponent(query), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })`
          : '',
      ].filter(Boolean);
      const methodBlocks = [...crudMethodImpls, customMethodImpls].filter(
        Boolean,
      );

      return `
  ${JSON.stringify(clientKey)}: {
${methodBlocks.join(',\n')}
  }`;
    })
    .join(',');

  return `
// Auto-generated API client from SMRT objects
// This file is generated automatically - do not edit

${CLIENT_FETCH_RUNTIME}

async function __smrtFetchActionResult(url, init) {
  const body = await __smrtFetchJson(url, init);
  return body &&
    typeof body === 'object' &&
    Object.prototype.hasOwnProperty.call(body, 'result')
    ? body.result
    : body;
}

function __smrtActionUrl(url, options, pathParamNames, includeQuery) {
  const values = options && typeof options === 'object' ? options : {};
  const pathParams = new Set(pathParamNames);
  let resolvedUrl = url;
  for (const name of pathParamNames) {
    const value = values[name];
    if (value === undefined || value === null) {
      throw new Error('Missing generated client route parameter: ' + name);
    }
    resolvedUrl = resolvedUrl.replace(
      '[' + name + ']',
      encodeURIComponent(String(value)),
    );
  }

  if (!includeQuery) return resolvedUrl;

  const searchParams = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (pathParams.has(name) || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(name, String(item));
      continue;
    }
    searchParams.append(
      name,
      value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : String(value),
    );
  }

  const query = searchParams.toString();
  return query ? resolvedUrl + '?' + query : resolvedUrl;
}

export function createClient(basePath = '/api/v1') {
  return {${clientMethods}
  };
}

export { createClient as default };
`;
}

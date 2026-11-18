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
      // Every value that reaches a request path is one encoded segment: the
      // static collection segment is emitted as a string literal, and a
      // caller-supplied id passes through `__smrtItemUrl` at run time.
      const collectionPath = `basePath + ${JSON.stringify(`/${collection}`)}`;
      const itemUrl = (suffix = '') =>
        `__smrtItemUrl(${collectionPath}, id${suffix ? `, ${JSON.stringify(suffix)}` : ''})`;

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
              ? `basePath + ${JSON.stringify(`/${collection}/${urlSegment}`)}`
              : itemUrl(`/${urlSegment}`);
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
          return `    ${methodName}: async (${args}) => __smrtWithUrl(${actionUrl}, (url) => __smrtFetchActionResult(url, ${requestInit}))`;
        })
        .join(',\n');

      // Every fetcher is async so an invalid argument (a missing named route
      // parameter included) rejects like a failed request does.
      const enabledCrudMethods = new Set(crudMethods);
      const crudMethodImpls = [
        enabledCrudMethods.has('list')
          ? `    list: async (params) => __smrtFetchJson(__smrtWithQuery(${collectionPath}, params), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })`
          : '',
        enabledCrudMethods.has('get')
          ? `    get: async (id) => __smrtWithUrl(${itemUrl()}, (url) => __smrtFetchJson(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }))`
          : '',
        enabledCrudMethods.has('create')
          ? `    create: async (data) => __smrtFetchJson(${collectionPath}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })`
          : '',
        enabledCrudMethods.has('update')
          ? `    update: async (id, data) => __smrtWithUrl(${itemUrl()}, (url) => __smrtFetchJson(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }))`
          : '',
        enabledCrudMethods.has('delete')
          ? `    delete: async (id) => __smrtWithUrl(${itemUrl()}, (url) => __smrtFetchOk(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    }))`
          : '',
        enabledCrudMethods.has('search')
          ? `    search: async (query) => __smrtFetchJson(basePath + ${JSON.stringify(`/${collection}/search?q=`)} + encodeURIComponent(query), {
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

// One caller-supplied value as exactly one path segment. Encoding keeps '/',
// '?', '#' and '%' inside the segment. An empty, '.' or '..' value cannot be
// one segment (the URL resolves it against its neighbours, onto another
// route), so it yields an Error that __smrtWithUrl turns into a rejected
// request promise instead of a request. A value that cannot be encoded (a
// lone UTF-16 surrogate) yields an Error for an item id; a named route
// parameter throws its URIError, which the async fetcher turns into a
// rejection.
function __smrtPathSegment(value, name, throwUnencodable) {
  const segment = String(value);
  if (segment === '' || segment === '.' || segment === '..') {
    return new Error(
      'Invalid generated client route parameter ' + name + ': ' +
        JSON.stringify(segment),
    );
  }
  if (throwUnencodable) return encodeURIComponent(segment);
  try {
    return encodeURIComponent(segment);
  } catch (cause) {
    // A lone UTF-16 surrogate cannot be encoded (URIError): reject the
    // request like any other unusable value instead of throwing.
    return new Error(
      'Invalid generated client route parameter ' + name +
        ': not a well-formed string',
      { cause },
    );
  }
}

function __smrtItemUrl(base, id, suffix) {
  const segment = __smrtPathSegment(id, 'id');
  return segment instanceof Error ? segment : base + '/' + segment + (suffix || '');
}

// An unusable URL rejects the request promise instead of sending a request.
function __smrtWithUrl(url, request) {
  return url instanceof Error ? Promise.reject(url) : request(url);
}

function __smrtActionUrl(url, options, pathParamNames, includeQuery) {
  const values = options && typeof options === 'object' ? options : {};
  for (const name of pathParamNames) {
    const value = values[name];
    if (value === undefined || value === null) {
      throw new Error('Missing generated client route parameter: ' + name);
    }
  }
  // Named parameters are encoded first, so an unencodable one rejects with
  // its URIError whatever else is wrong with the call.
  const segments = pathParamNames.map((name) =>
    __smrtPathSegment(values[name], name, true),
  );
  if (url instanceof Error) return url;
  let resolvedUrl = url;
  for (const [index, name] of pathParamNames.entries()) {
    const segment = segments[index];
    if (segment instanceof Error) return segment;
    resolvedUrl = resolvedUrl.replace('[' + name + ']', segment);
  }

  return includeQuery
    ? __smrtWithQuery(resolvedUrl, values, pathParamNames)
    : resolvedUrl;
}

function __smrtWithQuery(url, values, skipNames) {
  if (!values || typeof values !== 'object') return url;
  const skip = new Set(skipNames || []);
  const searchParams = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (skip.has(name) || value === undefined) continue;
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
  return query ? url + '?' + query : url;
}

export function createClient(basePath = '/api/v1') {
  return {${clientMethods}
  };
}

export { createClient as default };
`;
}

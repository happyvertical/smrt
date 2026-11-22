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
          return `    ${methodName}: async (${args}) => __smrtSendAction(${route}, options, ${JSON.stringify(
            routeConfig.pathParamNames,
          )}, ${JSON.stringify(routeConfig.method)})`;
        })
        .join(',\n');

      // Every fetcher is async so an invalid argument (a missing named route
      // parameter included) rejects like a failed request does.
      const enabledCrudMethods = new Set(crudMethods);
      const crudMethodImpls = [
        enabledCrudMethods.has('list')
          ? `    list: async (params) => __smrtFetchJson(__smrtListUrl(${collectionPath}, params), {
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

// One custom action call. A named route parameter is the caller's own
// property, read exactly once: an inherited one ('toString', 'constructor')
// is missing, not a function's source text, and the value read for the path
// is the value the query or the body carries.
function __smrtSendAction(url, options, pathParamNames, method) {
  const values = options && typeof options === 'object' ? options : {};
  const pathValues = pathParamNames.map((name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined,
  );
  const resolvedUrl = __smrtActionUrl(url, pathParamNames, pathValues);
  if (method === 'GET') {
    return __smrtWithUrl(resolvedUrl, (target) =>
      __smrtFetchActionResult(__smrtWithQuery(target, values, pathParamNames), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      }),
    );
  }
  return __smrtWithUrl(resolvedUrl, (target) =>
    __smrtFetchActionResult(target, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(__smrtActionBody(options, pathParamNames, pathValues)),
    }),
  );
}

// The JSON body: the options as JSON.stringify would serialise them (the
// caller's own toJSON() included), except that a named route parameter the
// serialised record carries holds the value already read for the path
// instead of being read again.
function __smrtActionBody(options, pathParamNames, pathValues) {
  if (
    pathParamNames.length === 0 ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    return options || {};
  }
  let source = options;
  if (typeof options.toJSON === 'function') {
    source = options.toJSON('');
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return source;
    }
  }
  // The serialiser chooses which keys travel; a path parameter it kept
  // carries the value the path was built from.
  const body = Object.create(null);
  for (const key of Object.keys(source)) {
    const index = pathParamNames.indexOf(key);
    body[key] = index >= 0 ? pathValues[index] : source[key];
  }
  return body;
}

function __smrtActionUrl(url, pathParamNames, pathValues) {
  for (const [index, name] of pathParamNames.entries()) {
    const value = pathValues[index];
    if (value === undefined || value === null) {
      throw new Error('Missing generated client route parameter: ' + name);
    }
  }
  // Named parameters are encoded first, so an unencodable one rejects with
  // its URIError whatever else is wrong with the call.
  const segments = pathParamNames.map((name, index) =>
    __smrtPathSegment(pathValues[index], name, true),
  );
  if (url instanceof Error) return url;
  let resolvedUrl = url;
  for (const [index, name] of pathParamNames.entries()) {
    const segment = segments[index];
    if (segment instanceof Error) return segment;
    resolvedUrl = resolvedUrl.replace('[' + name + ']', segment);
  }
  return resolvedUrl;
}

// GET custom-action query: arrays repeat the key with String(member), other
// objects JSON-encode, and a Date (scalar or member) is its ISO string, the
// form the action route decodes for a Date parameter. A named route
// parameter is skipped before it is read, so it is read only for the path.
function __smrtWithQuery(url, values, skipNames) {
  if (!values || typeof values !== 'object') return url;
  const skip = new Set(skipNames || []);
  const searchParams = new URLSearchParams();
  for (const name of Object.keys(values)) {
    if (skip.has(name)) continue;
    const value = values[name];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(
          name,
          item instanceof Date ? item.toISOString() : String(item),
        );
      }
      continue;
    }
    searchParams.append(name, __smrtQueryText(value));
  }

  const query = searchParams.toString();
  return query ? url + '?' + query : url;
}

function __smrtQueryText(value) {
  if (value instanceof Date) return value.toISOString();
  return value !== null && typeof value === 'object'
    ? JSON.stringify(value)
    : String(value);
}

// list(params) writes the one query grammar both list routes read
// (parseRestListWhere): limit, offset, orderBy (a string, or a list of terms
// joined with commas), field=value and field[op]=value with op one of gt,
// gte, lt, lte, ne, in, like. An [in] operand is a non-empty list (in every
// form, the structured { op: 'in', value } included) sent as one comma-joined
// value. params and params.where are plain records; where ({ field: value },
// { field: { op, value } } or { 'field op': value }) flattens into the same
// parameters. A value is a string, number, boolean, bigint or Date (its ISO
// string). Anything the routes would read with another meaning (an empty or
// scalar [in] operand, null, a list member holding a comma, an object, a Map
// or other non-record container, one parameter given twice) rejects before
// any request is sent.
const __SMRT_LIST_OPERATORS = {
  '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '!=': 'ne', in: 'in', like: 'like',
};
const __SMRT_LIST_REST_OPERATORS = new Set(Object.values(__SMRT_LIST_OPERATORS));
const __SMRT_LIST_RESERVED = new Set(['limit', 'offset', 'orderBy']);

function __smrtListError(name, reason) {
  return new Error(
    'Invalid generated client list parameter ' + JSON.stringify(name) + ': ' + reason,
  );
}

// A query name or value must be a well-formed string: URLSearchParams turns
// a lone UTF-16 surrogate into U+FFFD, which would filter on another string.
function __smrtListWellFormed(name, text) {
  try {
    encodeURIComponent(text);
  } catch {
    throw __smrtListError(name, 'not a well-formed string');
  }
  return text;
}

function __smrtListText(name, value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw __smrtListError(name, 'invalid Date');
    return value.toISOString();
  }
  if (typeof value === 'string') return __smrtListWellFormed(name, value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw __smrtListError(name, 'not a finite number');
    return String(value);
  }
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value === null) {
    throw __smrtListError(name, 'null has no list query form');
  }
  throw __smrtListError(name, 'expected a string, number, boolean or Date');
}

function __smrtListParam(name, value) {
  const membership = /\\[in\\]$/.test(name);
  if (membership && !Array.isArray(value)) {
    throw __smrtListError(name, 'an [in] operand must be a non-empty list');
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw __smrtListError(name, 'an empty list would match every row');
    }
    if (name === 'orderBy') {
      return value.map((term) => __smrtListText(name, term)).join(',');
    }
    if (!membership) {
      throw __smrtListError(name, 'a list needs the [in] operator');
    }
    return value
      .map((member) => {
        const text = __smrtListText(name, member);
        if (text.includes(',')) {
          throw __smrtListError(name, 'an [in] member cannot contain a comma');
        }
        return text;
      })
      .join(',');
  }
  return __smrtListText(name, value);
}

// A plain record (Object.prototype or no prototype). A Map, URLSearchParams,
// Date, array or class instance has no own entries to read as parameters,
// so reading it would send an unfiltered request.
function __smrtIsPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function __smrtListWhere(where, add) {
  if (!__smrtIsPlainRecord(where)) {
    throw __smrtListError('where', 'expected an object of conditions');
  }
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    const parts = key.trim().split(/\\s+/);
    let field = parts[0];
    let operator = parts.slice(1).join(' ');
    let value = condition;
    if (
      condition !== null &&
      typeof condition === 'object' &&
      !Array.isArray(condition) &&
      !(condition instanceof Date)
    ) {
      if (
        operator ||
        !Object.prototype.hasOwnProperty.call(condition, 'op') ||
        !Object.prototype.hasOwnProperty.call(condition, 'value')
      ) {
        throw __smrtListError('where.' + key, 'expected a value or { op, value }');
      }
      // An explicit op is one of the supported operator strings; null,
      // false or '' is not "no operator".
      if (
        typeof condition.op !== 'string' ||
        (condition.op !== '=' &&
          !Object.prototype.hasOwnProperty.call(__SMRT_LIST_OPERATORS, condition.op))
      ) {
        throw __smrtListError(
          'where.' + key,
          'unsupported operator ' + JSON.stringify(String(condition.op)),
        );
      }
      operator = condition.op;
      value = condition.value;
    }
    if (!field || __SMRT_LIST_RESERVED.has(field)) {
      throw __smrtListError('where.' + key, 'not a filterable field name');
    }
    if (!operator || operator === '=') {
      add(field, value);
      continue;
    }
    const token = Object.prototype.hasOwnProperty.call(__SMRT_LIST_OPERATORS, operator)
      ? __SMRT_LIST_OPERATORS[operator]
      : undefined;
    if (!token) {
      throw __smrtListError('where.' + key, 'unsupported operator ' + JSON.stringify(operator));
    }
    add(field + '[' + token + ']', value);
  }
}

function __smrtListUrl(url, params) {
  // Only undefined means "no params"; null is not an empty filter.
  if (params === undefined) return url;
  if (!__smrtIsPlainRecord(params)) {
    throw __smrtListError('params', 'expected a plain object');
  }
  const searchParams = new URLSearchParams();
  const add = (name, value) => {
    if (value === undefined) return;
    __smrtListWellFormed(name, name);
    const operator = /\\[([^\\]]*)\\]$/.exec(name);
    if (operator && !__SMRT_LIST_REST_OPERATORS.has(operator[1])) {
      throw __smrtListError(name, 'unsupported operator ' + JSON.stringify(operator[1]));
    }
    if (searchParams.has(name)) {
      throw __smrtListError(name, 'given more than once');
    }
    searchParams.append(name, __smrtListParam(name, value));
  };
  for (const [name, value] of Object.entries(params)) {
    if (name === 'where' && value !== null && typeof value === 'object') {
      __smrtListWhere(value, add);
      continue;
    }
    add(name, value);
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

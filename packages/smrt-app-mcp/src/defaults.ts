/**
 * Defaults for an application MCP server built from the app's own declared
 * models. The defaults can only narrow what `createMcpAppServer` exposes:
 * the allow-list is the explicit model list, and every authenticated caller
 * must be a principal of an accepted kind with a stable id, a tenant, and
 * every required scope. Applications that need a wider policy compose
 * `createMcpAppServer` directly.
 *
 * @packageDocumentation
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { McpResourcePolicy } from './resources.js';
import {
  type CreateMcpAppServerOptions,
  createMcpAppServer,
  type McpAppPrincipal,
  type McpAppServer,
  type McpTaskPrincipalPolicy,
  type McpToolPolicy,
} from './server.js';

/** A `@smrt()` model constructor whose generated tools the app publishes. */
export type McpAppModel = Parameters<
  typeof ObjectRegistry.getClassByConstructor
>[0];

/** Server identity used when an application does not supply one. */
export const DEFAULT_MCP_APP_SERVER_INFO = Object.freeze({
  name: 'smrt-app',
  version: '0.1.0',
});

/**
 * Resolve the registered class names for an explicit list of model
 * constructors. Every entry must be a registered `@smrt()` class; nothing is
 * inferred from the registry, so an application never publishes framework or
 * dependency models by accident.
 */
export function mcpAllowedClassNames(models: readonly McpAppModel[]): string[] {
  if (!Array.isArray(models)) {
    throw new TypeError('MCP models must be an explicit array.');
  }
  const names = new Set<string>();
  for (const model of models) {
    const registered =
      typeof model === 'function'
        ? ObjectRegistry.getClassByConstructor(model)
        : undefined;
    if (!registered?.name) {
      throw new TypeError(
        'MCP models must be registered @smrt() class constructors.',
      );
    }
    names.add(registered.name);
  }
  return [...names];
}

/** Options for {@link mcpPrincipalScopePolicy}. */
export interface McpPrincipalScopePolicyOptions {
  /** Every scope an authenticated principal must hold. May be empty. */
  requiredScopes: readonly string[];
  /** Accepted principal kinds. Defaults to `['human']`. */
  principalKinds?: readonly string[];
}

const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;

function snapshotStrings(
  values: readonly string[] | undefined,
  label: string,
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`MCP ${label} must be an explicit array.`);
  }
  for (const value of values) {
    if (typeof value !== 'string' || !scopePattern.test(value)) {
      throw new TypeError(`Invalid MCP ${label} entry.`);
    }
  }
  return Object.freeze([...new Set(values)]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Build the default principal policy shared by tools and resources.
 *
 * An authenticated principal passes only with an accepted `kind`, a stable
 * `id`, a `tenantId`, and every required scope. An absent principal passes
 * this policy because the server's base rule has already restricted it to
 * tools selected by `publicToolPatterns` that are read-only, and to resources
 * explicitly declared `public: true`; with neither configured an anonymous
 * caller reaches nothing.
 */
export function mcpPrincipalScopePolicy(
  options: McpPrincipalScopePolicyOptions,
): (context: { principal: McpAppPrincipal | null }) => boolean {
  const requiredScopes = snapshotStrings(
    options.requiredScopes,
    'requiredScopes',
  );
  const kinds = snapshotStrings(
    options.principalKinds ?? ['human'],
    'principalKinds',
  );
  return ({ principal }) => {
    if (principal === null) return true;
    if (!principal || typeof principal !== 'object') return false;
    if (!nonEmptyString(principal.kind) || !kinds.includes(principal.kind))
      return false;
    if (!nonEmptyString(principal.id) || !nonEmptyString(principal.tenantId))
      return false;
    const held = principal.scopes;
    if (!Array.isArray(held)) return requiredScopes.length === 0;
    return requiredScopes.every((scope) => held.includes(scope));
  };
}

/** Options for {@link createDefaultMcpAppServer}. */
export interface CreateDefaultMcpAppServerOptions
  extends Omit<
    CreateMcpAppServerOptions,
    | 'allowedClassNames'
    | 'serverInfo'
    | 'toolPolicy'
    | 'resourcePolicy'
    | 'taskPrincipalPolicy'
  > {
  /**
   * The app's own `@smrt()` models to publish. Explicit: nothing else that is
   * registered (framework, dependency or fixture models) is exposed.
   */
  models: readonly McpAppModel[];
  /**
   * Scopes every authenticated principal must hold for every tool and
   * resource. With the SvelteKit session default these are the permission
   * slugs from `locals.permissions` (for example `items.read`); with bearer
   * authentication they are the token's granted scopes. Required so the
   * permission gate is always an explicit application decision; pass `[]`
   * only when every authenticated tenant member may use every published tool.
   */
  requiredScopes: readonly string[];
  /** Accepted principal kinds. Defaults to `['human']`. */
  principalKinds?: readonly string[];
  /** Server identity. Defaults to {@link DEFAULT_MCP_APP_SERVER_INFO}. */
  serverInfo?: CreateMcpAppServerOptions['serverInfo'];
  /** Additional tool policy. Composed with the default; it can only narrow. */
  toolPolicy?: McpToolPolicy;
  /** Additional resource policy. Composed with the default; it can only narrow. */
  resourcePolicy?: McpResourcePolicy;
  /**
   * Additional task lifecycle predicate. Composed with the default principal
   * scope policy, which already gates `tasks/get`/`update`/`cancel`; it can
   * only narrow.
   */
  taskPrincipalPolicy?: McpTaskPrincipalPolicy;
}

/**
 * Create an `McpAppServer` from the app's declared models with the default
 * principal policy. Unauthenticated callers keep the base public read-only
 * rule; mutating tools always require an authenticated principal. Because the
 * default policy is principal-aware, `tools/list` stays privately cacheable
 * even when `toolListCache` requests public caching.
 */
export function createDefaultMcpAppServer(
  options: CreateDefaultMcpAppServerOptions,
): McpAppServer {
  const {
    models,
    requiredScopes,
    principalKinds,
    serverInfo,
    toolPolicy: narrowTool,
    resourcePolicy: narrowResource,
    taskPrincipalPolicy: narrowTask,
    ...rest
  } = options;
  const allowedClassNames = mcpAllowedClassNames(models);
  const base = mcpPrincipalScopePolicy({ requiredScopes, principalKinds });
  return createMcpAppServer({
    ...rest,
    serverInfo: serverInfo ?? { ...DEFAULT_MCP_APP_SERVER_INFO },
    allowedClassNames,
    // The server already treats a thrown policy as a denial.
    toolPolicy: async (context) =>
      base(context) && (narrowTool ? Boolean(await narrowTool(context)) : true),
    resourcePolicy: async (context) =>
      base(context) &&
      (narrowResource ? Boolean(await narrowResource(context)) : true),
    // Lifecycle calls carry no tool; the principal-level requirements
    // (kind, id, tenant, every required scope of the effective principal)
    // still apply, so live revocation reaches existing tasks.
    taskPrincipalPolicy: async (context) =>
      base(context) && (narrowTask ? Boolean(await narrowTask(context)) : true),
  });
}

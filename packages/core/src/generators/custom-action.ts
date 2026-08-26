/**
 * Canonical custom-action metadata and transport-safe result helpers.
 *
 * Custom actions are intentionally distinct from generated CRUD. Their target
 * is derived from method metadata: instance methods target an item and static
 * methods target the collection. API route configuration may shape an HTTP
 * route, but it cannot change a method's receiver.
 */

import type { ToolEffect } from '../registry/types.js';
import type { MethodDefinition } from '../scanner/types.js';
import { convertTypeToJsonSchema } from '../tools/tool-generator.js';

export type CustomActionScope = 'item' | 'collection';
export type { ToolEffect } from '../registry/types.js';

export interface CustomActionMetadata {
  scope: CustomActionScope;
  /** An item-targeted action requires its target identifier. */
  idRequired: boolean;
  /** Present only when scanner/manifest metadata is available. */
  parameters?: MethodDefinition['parameters'];
  /** Collection actions on a model class invoke its static method. */
  isStatic: boolean;
  /** Browser/agent-visible effect. Omitted declarations fail closed. */
  effect: ToolEffect;
  /** Whether repeating the action with the same arguments is safe. */
  idempotent: boolean;
  /** Whether the opaque action may interact outside the SMRT application. */
  openWorld: boolean;
}

/**
 * Return the transport field for a method parameter. Flat tool and CLI
 * transports reserve `id` for receiver parsing even when a collection action
 * rejects it, so every action parameter named `id` is exposed as `actionId`.
 * REST already has separate path/body namespaces.
 */
export function customActionParameterInputName(
  _metadata: Pick<CustomActionMetadata, 'idRequired'>,
  parameterName: string,
): string {
  return parameterName === 'id' ? 'actionId' : parameterName;
}

export interface ResolveCustomActionMetadataOptions {
  actionName: string;
  method?: {
    isStatic?: boolean;
    parameters?: MethodDefinition['parameters'];
  };
  apiConfig?: unknown;
  /** Collection-class actions have a collection receiver even when non-static. */
  defaultScope?: CustomActionScope;
}

type JsonSchema = Record<string, unknown>;
type ToolArgs = Record<string, unknown>;

/**
 * Resolve the target contract shared by MCP, generated REST, CLI discovery,
 * and WebMCP. A missing manifest method retains the historical item-shaped
 * schema; runtime callers may still provide their legacy collection fallback.
 */
export function resolveCustomActionMetadata(
  options: ResolveCustomActionMetadataOptions,
): CustomActionMetadata {
  const defaultScope =
    options.defaultScope ?? (options.method?.isStatic ? 'collection' : 'item');
  const requestedScope = readConfiguredScope(
    options.apiConfig,
    options.actionName,
  );
  // A route-only scope override cannot manufacture a receiver. A normal
  // instance method is always item-targeted; a static model method and a
  // recognized collection-class method are always collection-targeted. Keep
  // a matching explicit value for diagnostics/config round-tripping only.
  const scope = requestedScope === defaultScope ? requestedScope : defaultScope;
  const configured = readConfiguredToolMetadata(
    options.apiConfig,
    options.actionName,
  );
  const effect = configured.effect ?? 'destructive';

  return {
    scope,
    idRequired: scope === 'item',
    ...(options.method?.parameters
      ? { parameters: options.method.parameters }
      : {}),
    isStatic: options.method?.isStatic === true,
    effect,
    idempotent: configured.idempotent ?? effect === 'read',
    openWorld: configured.openWorld ?? true,
  };
}

/** Build the custom-action portion of an MCP/WebMCP JSON Schema. */
export function buildCustomActionInputSchema(
  metadata: CustomActionMetadata,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  if (metadata.idRequired) {
    properties.id = {
      type: 'string',
      description: 'ID of the object to execute action on',
    };
    required.push('id');
  }

  // Absent metadata is the legacy options-bag contract. Do not infer direct
  // positional arguments from runtime function arity: it is lossy after
  // transpilation and would make discovery non-deterministic.
  if (!metadata.parameters) {
    properties.options = {
      type: 'object',
      description: 'Additional options for the custom action',
      additionalProperties: true,
    };
  } else if (
    metadata.parameters.length === 1 &&
    metadata.parameters[0]?.name === 'options'
  ) {
    const parameter = metadata.parameters[0];
    properties.options = {
      ...convertTypeToJsonSchema(parameter.type),
      description: 'Options for the custom action',
      ...(parameter.default !== undefined
        ? { default: parameter.default }
        : {}),
    };
    if (!parameter.optional) required.push('options');
  } else {
    for (const parameter of metadata.parameters) {
      const inputName = customActionParameterInputName(
        metadata,
        parameter.name,
      );
      properties[inputName] = {
        ...convertTypeToJsonSchema(parameter.type),
        ...(parameter.default !== undefined
          ? { default: parameter.default }
          : {}),
      };
      if (!parameter.optional) required.push(inputName);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Translate a transport object into the method's call arguments. Legacy
 * actions retain their single options-bag invocation; scanner metadata enables
 * an exact positional projection without changing legacy action behavior.
 */
export function buildCustomActionInvocationArgs(
  metadata: CustomActionMetadata,
  args: ToolArgs,
): unknown[] {
  const { id: _id, options, ...directArgs } = args;

  if (!metadata.parameters) {
    return [
      isRecord(options) && Object.keys(options).length > 0
        ? options
        : directArgs,
    ];
  }
  if (metadata.parameters.length === 0) return [];
  if (
    metadata.parameters.length === 1 &&
    metadata.parameters[0]?.name === 'options'
  ) {
    // Preserve `undefined` (and an explicit `null`) so JavaScript default
    // parameter initializers and intentional null handling retain their native
    // semantics. Legacy options bags still receive an empty object below.
    return [options];
  }
  return metadata.parameters.map(
    (parameter) =>
      args[customActionParameterInputName(metadata, parameter.name)],
  );
}

/**
 * Domain-neutral returned-failure convention for custom actions. The explicit
 * `ok: false` marker prevents successful opaque values such as `{ code,
 * message }` from being reclassified as failures by a transport.
 */
export interface CustomActionFailure {
  ok: false;
  code: string;
  message: string;
  status: number;
  details?: unknown;
  retryable?: boolean;
  correlationId?: string;
}

/** Stable MCP `_meta` member shared with the app discovery contract (#2181). */
export const SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY = 'io.happyvertical/smrt';

/**
 * Detect, validate, and redact an explicitly returned custom-action failure.
 * Unknown return values remain opaque successes. `status` defaults to 400 so
 * REST callers receive non-2xx semantics even when an adapter omits it.
 */
export function normalizeCustomActionFailure(
  value: unknown,
): CustomActionFailure | undefined {
  if (!isRecord(value) || value.ok !== false) return undefined;
  if (typeof value.code !== 'string' || typeof value.message !== 'string') {
    return undefined;
  }

  const status =
    typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 400 &&
    value.status <= 599
      ? value.status
      : 400;

  return {
    ok: false,
    code: value.code,
    message: redactText(value.message),
    status,
    ...(Object.hasOwn(value, 'details')
      ? { details: redactValue(value.details) }
      : {}),
    ...(typeof value.retryable === 'boolean'
      ? { retryable: value.retryable }
      : {}),
    ...(typeof value.correlationId === 'string'
      ? { correlationId: value.correlationId }
      : {}),
  };
}

function readConfiguredScope(
  apiConfig: unknown,
  actionName: string,
): CustomActionScope | undefined {
  if (!isRecord(apiConfig) || !isRecord(apiConfig.routes)) return undefined;
  const route = apiConfig.routes[actionName];
  return isRecord(route) &&
    (route.scope === 'item' || route.scope === 'collection')
    ? route.scope
    : undefined;
}

function readConfiguredToolMetadata(
  apiConfig: unknown,
  actionName: string,
): {
  effect?: ToolEffect;
  idempotent?: boolean;
  openWorld?: boolean;
} {
  if (!isRecord(apiConfig) || !isRecord(apiConfig.routes)) return {};
  const route = apiConfig.routes[actionName];
  if (!isRecord(route)) return {};
  const effect =
    route.effect === 'read' ||
    route.effect === 'write' ||
    route.effect === 'destructive'
      ? route.effect
      : undefined;
  return {
    ...(effect ? { effect } : {}),
    ...(typeof route.idempotent === 'boolean'
      ? { idempotent: route.idempotent }
      : {}),
    ...(typeof route.openWorld === 'boolean'
      ? { openWorld: route.openWorld }
      : {}),
  };
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED]';
  seen.add(value);
  if (Array.isArray(value))
    return value.map((entry) => redactValue(entry, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return '[REDACTED]';
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactValue(nested, seen);
  }
  return result;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(token|secret|password|api[_-]?key)=([^\s&]+)/giu,
      '$1=[REDACTED]',
    );
}

function isSensitiveKey(key: string): boolean {
  return /(?:token|secret|password|authorization|cookie|credential|api[_-]?key)/iu.test(
    key,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Consumer policy is process-local and monotonic until ObjectRegistry.clear(). */
import { ConfigurationError } from '../errors';
import { isQualifiedName } from '../utils/qualified-names.js';
import { bumpRegistryGeneration } from './generation';
import { getClasses } from './shared-state';
import type { RegisteredClass } from './types';

export interface RuntimeRegistrationOverride {
  api?: false | { include: readonly [] };
  mcp?: false | { include: readonly [] };
  cli?: false | { include: readonly [] };
  tenancy?: { mode: 'required' };
}

type Policy = Readonly<{
  api?: false;
  mcp?: false;
  cli?: false;
  tenancy?: Readonly<NonNullable<RegisteredClass['tenantScopedConfig']>>;
}>;
declare global {
  var __smrtRuntimeOverrides: Map<string, Policy> | undefined;
}

function policies(): Map<string, Policy> {
  globalThis.__smrtRuntimeOverrides ??= new Map();
  return globalThis.__smrtRuntimeOverrides;
}

export function clearRuntimeOverrides(): void {
  policies().clear();
}

export function getRuntimeOverride(name: string): Policy | undefined {
  return policies().get(name);
}

function invalid(message: string): never {
  throw new ConfigurationError(message, 'CONFIG_INVALID_RUNTIME_OVERRIDE');
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Carry consumer restrictions when a same-named subtype replaces its parent. */
export function transferRuntimeOverride(from: string, to: string): void {
  const previous = policies().get(from);
  if (!previous || from === to) return;
  policies().set(to, Object.freeze({ ...policies().get(to), ...previous }));
  policies().delete(from);
}

/** Validate completely before installing any part of a policy. */
export function registerRuntimeOverride(
  name: string,
  input: RuntimeRegistrationOverride,
): void {
  const registered = getClasses().get(name);
  if (
    !isQualifiedName(name) ||
    !registered ||
    registered.qualifiedName !== name
  ) {
    invalid(
      `Runtime overrides require an existing canonical qualified class: '${name}'.`,
    );
  }
  if (!object(input)) invalid('Runtime override must be an object.');
  const next: {
    api?: false;
    mcp?: false;
    cli?: false;
    tenancy?: NonNullable<RegisteredClass['tenantScopedConfig']>;
  } = { ...policies().get(name) };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'api' || key === 'mcp' || key === 'cli') {
      if (
        value !== false &&
        !(
          object(value) &&
          Object.keys(value).length === 1 &&
          Array.isArray(value.include) &&
          value.include.length === 0
        )
      ) {
        invalid(
          `Runtime override '${key}' can only close a surface (false or { include: [] }).`,
        );
      }
      next[key] = false;
    } else if (key === 'tenancy') {
      if (
        !object(value) ||
        Object.keys(value).length !== 1 ||
        value.mode !== 'required'
      ) {
        invalid('Runtime tenancy overrides only accept { mode: required }.');
      }
      if (!registered.tenantScopedConfig) {
        invalid(
          `'${name}' must already declare tenancy; runtime overrides cannot change schema.`,
        );
      }
      next.tenancy = Object.freeze({
        ...registered.tenantScopedConfig,
        mode: 'required',
      });
    } else {
      invalid(`Unknown runtime override '${key}'.`);
    }
  }
  policies().set(name, Object.freeze(next));
  applyRuntimeOverrides();
  bumpRegistryGeneration();
}

/** Reapply after every registration writer, including late manifests and HMR. */
export function applyRuntimeOverrides(): void {
  for (const [name, policy] of policies()) {
    const registered = getClasses().get(name);
    if (!registered) continue;
    apply(registered, policy);
  }
}

function apply(registered: RegisteredClass, policy: Policy): void {
  registered.config = { ...registered.config };
  for (const key of ['api', 'mcp', 'cli'] as const) {
    if (policy[key] === false) registered.config[key] = false;
  }
  if (policy.tenancy) {
    const removed = !registered.fields.has(policy.tenancy.field);
    registered.tenantScopedConfig = { ...policy.tenancy };
    if (removed) {
      invalid(
        `Registration '${registered.qualifiedName}' removed the tenant field required by a runtime override.`,
      );
    }
  }
}

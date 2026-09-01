import { createHash } from 'node:crypto';

import type { ApplicationRuntimeProfile } from '@happyvertical/smrt-config';

export const RUNTIME_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const MAX_RUNTIME_DIAGNOSTIC_TOOLS = 64;
export const MAX_RUNTIME_DIAGNOSTIC_ERRORS = 8;
export const RUNTIME_WORKER_FRESHNESS_SECONDS = 120;

const CAPABILITY_IDS = [
  'asset-storage',
  'authentication',
  'background-jobs',
  'database',
  'paid-capabilities',
  'secret-storage',
] as const;

const ERROR_CODES = [
  'authentication_unavailable',
  'database_unavailable',
  'migration_required',
  'provider_unavailable',
  'runtime_stopped',
  'worker_stale',
] as const;

const PROHIBITED_IDENTIFIER_PARTS = new Set([
  'authorization',
  'cookie',
  'constructor',
  'credential',
  'email',
  'hash',
  'key',
  'log',
  'logs',
  'password',
  'path',
  'record',
  'prototype',
  'secret',
  'session',
  'stack',
  'tenant',
  'token',
  'url',
  'user',
]);

type CapabilityId = (typeof CAPABILITY_IDS)[number];
type CapabilityStatus = 'available' | 'disabled' | 'unavailable' | 'unknown';
type RuntimeDiagnosticErrorCode =
  | (typeof ERROR_CODES)[number]
  | 'runtime_error';
type WorkerTopology = 'embedded' | 'external' | 'inline' | 'scalable';

/**
 * Versioned public diagnostics returned only after application authorization.
 * Every field is a fixed allowlist projection; this is intentionally not a
 * cleaned or serialized form of either private runtime diagnostics object.
 */
export interface RuntimeDiagnostics {
  readonly schemaVersion: 1;
  readonly profile: ApplicationRuntimeProfile | 'unknown';
  readonly health: 'healthy' | 'degraded' | 'stopped' | 'unknown';
  readonly schema: {
    readonly status: 'ready' | 'not-ready' | 'unknown';
    readonly migrations: 'current' | 'failed' | 'pending' | 'unknown';
  };
  readonly capabilities: readonly {
    readonly id: CapabilityId;
    readonly status: CapabilityStatus;
  }[];
  readonly tools: {
    readonly names: readonly string[];
    readonly count: number;
    readonly digest: string;
  };
  readonly operationalDifferences: {
    readonly backgroundJobs: 'disabled' | 'enabled';
    readonly workerTopology: WorkerTopology;
  };
  readonly worker: {
    readonly topology: WorkerTopology;
    readonly liveness: 'alive' | 'not-required' | 'stale' | 'unknown';
    readonly heartbeatAt: string | null;
    readonly observedAt: string;
  };
  readonly recentErrors: readonly {
    readonly code: RuntimeDiagnosticErrorCode;
    readonly at: string;
  }[];
}

export interface RuntimeDiagnosticsProjectionInput {
  readonly profile?: unknown;
  readonly health?: unknown;
  readonly schema?: unknown;
  readonly capabilities?: unknown;
  readonly toolNames?: unknown;
  readonly worker?: unknown;
  readonly recentErrors?: unknown;
  /** Required explicit clock seam; the projector never reads the process clock. */
  readonly observedAt?: unknown;
}

/**
 * Project private local/deployed state into the deterministic public contract.
 * Unknown, oversized, nested, accessor-backed, or prohibited values are never
 * copied. Invalid error codes become `runtime_error` at ingestion.
 */
export function projectRuntimeDiagnostics(
  input: RuntimeDiagnosticsProjectionInput,
): RuntimeDiagnostics {
  const source = plainRecord(input);
  const observedAtValue = read(source, 'observedAt');
  const observedAtMilliseconds = timestampMilliseconds(observedAtValue);
  const observedAt = coarseTimestamp(observedAtValue) ?? EPOCH;
  const profile = runtimeProfile(read(source, 'profile'));
  const worker = projectWorker(
    read(source, 'worker'),
    observedAt,
    observedAtMilliseconds,
  );
  const capabilities = projectCapabilities(read(source, 'capabilities'));
  const tools = canonicalTools(read(source, 'toolNames'));

  return deepFreeze({
    schemaVersion: RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    profile,
    health: oneOf(read(source, 'health'), HEALTH_VALUES, 'unknown'),
    schema: projectSchema(read(source, 'schema')),
    capabilities,
    tools: {
      names: tools,
      count: tools.length,
      digest: createHash('sha256').update(tools.join('\n')).digest('hex'),
    },
    operationalDifferences: {
      backgroundJobs:
        capabilityStatus(capabilities, 'background-jobs') === 'available'
          ? 'enabled'
          : 'disabled',
      workerTopology: worker.topology,
    },
    worker,
    recentErrors: projectErrors(read(source, 'recentErrors')),
  });
}

const EPOCH = '1970-01-01T00:00:00.000Z';
const PROFILES = ['local', 'self-hosted', 'cloud', 'unknown'] as const;
const HEALTH_VALUES = ['healthy', 'degraded', 'stopped', 'unknown'] as const;
const SCHEMA_VALUES = ['ready', 'not-ready', 'unknown'] as const;
const MIGRATION_VALUES = ['current', 'failed', 'pending', 'unknown'] as const;
const CAPABILITY_VALUES = [
  'available',
  'disabled',
  'unavailable',
  'unknown',
] as const;
const WORKER_TOPOLOGIES = [
  'embedded',
  'external',
  'inline',
  'scalable',
] as const;

function runtimeProfile(value: unknown): ApplicationRuntimeProfile | 'unknown' {
  return oneOf(value, PROFILES, 'unknown');
}

function projectSchema(value: unknown): RuntimeDiagnostics['schema'] {
  const source = plainRecord(value);
  return {
    status: oneOf(read(source, 'status'), SCHEMA_VALUES, 'unknown'),
    migrations: oneOf(read(source, 'migrations'), MIGRATION_VALUES, 'unknown'),
  };
}

function projectCapabilities(
  value: unknown,
): RuntimeDiagnostics['capabilities'] {
  const source = plainRecord(value);
  return CAPABILITY_IDS.map((id) => ({
    id,
    status: oneOf(read(source, id), CAPABILITY_VALUES, 'unknown'),
  }));
}

function canonicalTools(value: unknown): readonly string[] {
  const names = new Set<string>();
  for (const candidate of safeArrayItems(
    value,
    MAX_RUNTIME_DIAGNOSTIC_TOOLS * 4,
  )) {
    if (typeof candidate !== 'string' || !isPublicIdentifier(candidate)) {
      continue;
    }
    names.add(candidate);
  }
  return [...names].sort().slice(0, MAX_RUNTIME_DIAGNOSTIC_TOOLS);
}

function isPublicIdentifier(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 80 ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)
  ) {
    return false;
  }
  const parts = value.split(/[._-]/);
  return !parts.some((part) => PROHIBITED_IDENTIFIER_PARTS.has(part));
}

function projectWorker(
  value: unknown,
  observedAt: string,
  observedAtMilliseconds: number | null,
): RuntimeDiagnostics['worker'] {
  const source = plainRecord(value);
  const topology = oneOf(read(source, 'topology'), WORKER_TOPOLOGIES, 'inline');
  const required = read(source, 'required') === true;
  const heartbeatValue = read(source, 'heartbeatAt');
  const heartbeatMilliseconds = timestampMilliseconds(heartbeatValue);
  const heartbeatAt = coarseTimestamp(heartbeatValue);
  let liveness: RuntimeDiagnostics['worker']['liveness'] = 'not-required';
  if (required) {
    liveness = 'unknown';
    if (heartbeatMilliseconds !== null && observedAtMilliseconds !== null) {
      const ageSeconds =
        (observedAtMilliseconds - heartbeatMilliseconds) / 1_000;
      if (ageSeconds >= 0) {
        liveness =
          ageSeconds <= RUNTIME_WORKER_FRESHNESS_SECONDS ? 'alive' : 'stale';
      }
    }
  }
  return { topology, liveness, heartbeatAt, observedAt };
}

function projectErrors(value: unknown): RuntimeDiagnostics['recentErrors'] {
  const errors: Array<RuntimeDiagnostics['recentErrors'][number]> = [];
  for (const candidate of safeArrayItems(
    value,
    MAX_RUNTIME_DIAGNOSTIC_ERRORS * 4,
  )) {
    const source = plainRecord(candidate);
    const at = coarseTimestamp(read(source, 'at'));
    if (!at) continue;
    const rawCode = read(source, 'code');
    const code: RuntimeDiagnosticErrorCode = ERROR_CODES.includes(
      rawCode as (typeof ERROR_CODES)[number],
    )
      ? (rawCode as (typeof ERROR_CODES)[number])
      : 'runtime_error';
    errors.push({ code, at });
  }
  return errors
    .sort((left, right) =>
      left.at === right.at
        ? left.code.localeCompare(right.code)
        : right.at.localeCompare(left.at),
    )
    .slice(0, MAX_RUNTIME_DIAGNOSTIC_ERRORS);
}

function capabilityStatus(
  capabilities: RuntimeDiagnostics['capabilities'],
  id: CapabilityId,
): CapabilityStatus {
  return (
    capabilities.find((capability) => capability.id === id)?.status ?? 'unknown'
  );
}

function coarseTimestamp(value: unknown): string | null {
  const milliseconds = timestampMilliseconds(value);
  if (milliseconds === null) return null;
  const minute = Math.floor(milliseconds / 60_000) * 60_000;
  return new Date(minute).toISOString();
}

function timestampMilliseconds(value: unknown): number | null {
  try {
    if (!(typeof value === 'string' || value instanceof Date)) return null;
    const milliseconds =
      value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

function oneOf<
  const Values extends readonly string[],
  Fallback extends Values[number],
>(value: unknown, values: Values, fallback: Fallback): Values[number] {
  return typeof value === 'string' && values.includes(value as Values[number])
    ? (value as Values[number])
    : fallback;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function read(source: Record<string, unknown> | null, key: string): unknown {
  try {
    if (!source || !Object.hasOwn(source, key)) {
      return undefined;
    }
    return source[key];
  } catch {
    return undefined;
  }
}

function safeArrayItems(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value)) return [];
    const length = Math.min(value.length, maximum);
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      try {
        items.push(value[index]);
      } catch {
        items.push(undefined);
      }
    }
    return items;
  } catch {
    return [];
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === 'object' && !Object.isFrozen(child)) {
        deepFreeze(child);
      }
    }
  }
  return value;
}

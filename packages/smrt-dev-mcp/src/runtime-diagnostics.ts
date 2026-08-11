import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeConfig } from '@happyvertical/smrt-config';
import {
  redactSystemDiagnosticText,
  type SystemDiagnosticEngine,
  type SystemDiagnosticMessage,
  type SystemDiagnosticResult,
  SystemDiagnosticsReader,
  type TrustedSystemDiagnosticScope,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { loadStaticRuntimeConfig } from './static-runtime-config.js';
import { introspectProject } from './tools/introspect-project.js';

export type RuntimeDiagnosticToolName =
  | 'migration-status'
  | 'job-health'
  | 'schedule-health'
  | 'dispatch-health'
  | 'recent-changes'
  | 'registry-drift';

export interface RuntimeDiagnosticToolArgs {
  rootDir?: string;
  dbUrl?: string;
  dbType?: SystemDiagnosticEngine;
  limit?: number;
  tenantId?: string;
  since?: number;
  tables?: string[];
  staleAfterMs?: number;
}

interface ResolvedRuntimeConnection {
  db: DatabaseInterface;
  engine: SystemDiagnosticEngine;
  source: 'argument' | 'environment' | 'config';
  scope: TrustedSystemDiagnosticScope;
  owned: boolean;
}

export interface RuntimeDiagnosticDependencies {
  env?: NodeJS.ProcessEnv;
  connect?: typeof getDatabase;
  configLoader?: (rootDir: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
  introspect?: typeof introspectProject;
  /** Test/host override; production connections are owned and closed per call. */
  ownsConnections?: boolean;
}

interface StaticOnlyResult {
  status: 'not-configured';
  mode: 'static-only';
  provenance: {
    source: 'static-only';
    observation: 'none';
    observedAt: string;
    connectionSource: null;
    scope: TrustedSystemDiagnosticScope;
  };
  data: null;
  diagnostics: SystemDiagnosticMessage[];
}

interface ConnectionUnavailableResult {
  status: 'unavailable';
  mode: 'runtime';
  provenance: {
    source: 'runtime';
    observation: 'connection-failed';
    observedAt: string;
    connectionSource: 'argument' | 'environment' | 'config' | null;
    scope: TrustedSystemDiagnosticScope;
  };
  data: null;
  diagnostics: SystemDiagnosticMessage[];
}

export type RuntimeDiagnosticToolResult =
  | SystemDiagnosticResult<unknown>
  | StaticOnlyResult
  | ConnectionUnavailableResult;

/**
 * Invoke one runtime diagnostic. Connection lookup is lazy and failures are
 * returned as sanitized diagnostic results so static MCP tools stay healthy.
 */
export async function runRuntimeDiagnostic(
  tool: RuntimeDiagnosticToolName,
  args: RuntimeDiagnosticToolArgs = {},
  dependencies: RuntimeDiagnosticDependencies = {},
): Promise<RuntimeDiagnosticToolResult> {
  const env = dependencies.env ?? process.env;
  const scope = trustedScope(env);
  const requestedScope = narrowRequestedTenant(scope, args.tenantId);
  if (!requestedScope.ok) {
    return connectionUnavailable(
      scope,
      null,
      'tenant-scope-denied',
      requestedScope.message,
    );
  }

  const connection = await resolveRuntimeConnection(
    args,
    requestedScope.scope,
    dependencies,
  );
  if ('result' in connection) return connection.result;

  const reader = new SystemDiagnosticsReader(connection.db, {
    engine: connection.engine,
    connectionSource: connection.source,
    scope: connection.scope,
  });
  const limit = finiteNumber(args.limit);
  const staleAfterMs = finiteNumber(args.staleAfterMs);

  try {
    switch (tool) {
      case 'migration-status':
        return await reader.migrationStatus({ limit });
      case 'job-health':
        return await reader.jobHealth({ limit });
      case 'schedule-health':
        return await reader.scheduleHealth({
          limit,
          overdueAfterMs: staleAfterMs,
        });
      case 'dispatch-health':
        return await reader.dispatchHealth({
          limit,
          stuckAfterMs: staleAfterMs,
        });
      case 'recent-changes':
        return await reader.recentChanges({
          limit,
          since: finiteNumber(args.since),
          tables: stringArray(args.tables),
        });
      case 'registry-drift':
        return await registryDrift(
          reader,
          args,
          dependencies.introspect ?? introspectProject,
        );
      default:
        return connectionUnavailable(
          connection.scope,
          connection.source,
          'diagnostic-unsupported',
          'The requested runtime diagnostic is not supported.',
        );
    }
  } finally {
    if (connection.owned) await closeDatabase(connection.db);
  }
}

/** Remove DB URLs and secret-shaped values before debug logging. */
export function sanitizeRuntimeArguments(args: unknown): unknown {
  return sanitizeConfig(args);
}

/** Redact any throwable before it is logged or returned by the MCP boundary. */
export function sanitizeRuntimeError(error: unknown): string {
  return redactSystemDiagnosticText(error);
}

async function resolveRuntimeConnection(
  args: RuntimeDiagnosticToolArgs,
  scope: TrustedSystemDiagnosticScope,
  dependencies: RuntimeDiagnosticDependencies,
): Promise<
  | { result: StaticOnlyResult | ConnectionUnavailableResult }
  | ResolvedRuntimeConnection
> {
  const env = dependencies.env ?? process.env;
  const configLoader = dependencies.configLoader ?? loadStaticRuntimeConfig;
  const rootDir = resolve(args.rootDir ?? process.cwd());
  let source: ResolvedRuntimeConnection['source'] | null = null;
  let url: string | undefined;
  let engine: SystemDiagnosticEngine | undefined;

  if (nonEmptyString(args.dbUrl)) {
    source = 'argument';
    url = args.dbUrl.trim();
    engine = supportedEngine(args.dbType) ?? inferEngine(url);
  } else if (nonEmptyString(env.SMRT_DEV_DB_URL)) {
    source = 'environment';
    url = env.SMRT_DEV_DB_URL.trim();
    engine = supportedEngine(env.SMRT_DEV_DB_TYPE) ?? inferEngine(url);
  } else {
    try {
      const config = await configLoader(rootDir, env);
      const database = packageDatabaseConfig(config);
      if (database?.url) {
        source = 'config';
        url = database.url;
        engine = supportedEngine(database.type) ?? inferEngine(url);
      }
    } catch {
      return {
        result: connectionUnavailable(
          scope,
          'config',
          'config-unavailable',
          'The project configuration could not be loaded for runtime diagnostics.',
        ),
      };
    }
  }

  if (!url) return { result: staticOnly(scope) };
  if (!engine) {
    return {
      result: connectionUnavailable(
        scope,
        source,
        'database-type-required',
        'The runtime database type could not be inferred; set dbType or SMRT_DEV_DB_TYPE.',
      ),
    };
  }

  try {
    const connect = dependencies.connect ?? getDatabase;
    const normalized = await validateDatabaseTarget(
      normalizeDatabaseUrl(url, engine, rootDir),
      engine,
      dependencies.connect !== undefined,
    );
    if (!normalized.ok) {
      return {
        result: connectionUnavailable(
          scope,
          source,
          normalized.code,
          normalized.message,
        ),
      };
    }
    const db = await connect({
      type: engine,
      url: normalized.url,
      ...(engine === 'duckdb'
        ? { autoRegisterJSON: false, writeStrategy: 'none' as const }
        : {}),
    } as Parameters<typeof getDatabase>[0]);
    return {
      db,
      engine,
      source: source ?? 'config',
      scope,
      owned: dependencies.ownsConnections ?? dependencies.connect === undefined,
    };
  } catch {
    return {
      result: connectionUnavailable(
        scope,
        source,
        'connection-unavailable',
        'The runtime database connection could not be opened.',
      ),
    };
  }
}

async function registryDrift(
  reader: SystemDiagnosticsReader,
  args: RuntimeDiagnosticToolArgs,
  introspect: typeof introspectProject,
): Promise<SystemDiagnosticResult<unknown>> {
  const observed = await reader.registrySnapshot({
    limit: finiteNumber(args.limit),
  });
  const declaredRaw = JSON.parse(
    await introspect({
      directory: resolve(args.rootDir ?? process.cwd()),
      detail: 'summary',
      includeFields: false,
      includeRelationships: false,
      includeMethods: false,
      maxChars: 200_000,
    }),
  ) as Record<string, unknown>;
  const declaredObjects = Array.isArray(declaredRaw.objects)
    ? declaredRaw.objects
        .filter(isRecord)
        .map((item) => ({
          className: stringOrEmpty(item.className),
          qualifiedName: optionalString(item.qualifiedName),
          tableName: optionalString(item.tableName),
        }))
        .filter((item) => item.className)
    : [];
  const observedObjects = observed.data?.registrations ?? [];
  const declaredNames = new Set(declaredObjects.map((item) => item.className));
  const observedNames = new Set(observedObjects.map((item) => item.className));

  return {
    ...observed,
    data: {
      declared: {
        source: 'static',
        observation: 'declared-artifact',
        manifestSource: optionalString(declaredRaw.manifestSource) ?? 'none',
        manifestPath: optionalString(declaredRaw.manifestPath),
        objectCount: Number(declaredRaw.objectCount ?? declaredObjects.length),
        objects: declaredObjects,
      },
      observed: observed.data
        ? {
            source: 'runtime',
            observation: 'live-db',
            registrations: observedObjects,
          }
        : null,
      drift: observed.data
        ? {
            declaredOnly: declaredObjects
              .filter((item) => !observedNames.has(item.className))
              .map((item) => item.className),
            registeredOnly: observedObjects
              .filter((item) => !declaredNames.has(item.className))
              .map((item) => item.className),
            matched: declaredObjects
              .filter((item) => observedNames.has(item.className))
              .map((item) => item.className),
          }
        : null,
    },
  };
}

function trustedScope(env: NodeJS.ProcessEnv): TrustedSystemDiagnosticScope {
  const tenantId = env.SMRT_DEV_TENANT_ID?.trim();
  return tenantId ? { mode: 'tenant', tenantId } : { mode: 'global' };
}

function narrowRequestedTenant(
  trusted: TrustedSystemDiagnosticScope,
  requested: string | undefined,
):
  | { ok: true; scope: TrustedSystemDiagnosticScope }
  | { ok: false; message: string } {
  const tenantId = requested?.trim();
  if (!tenantId) return { ok: true, scope: trusted };
  if (trusted.mode === 'tenant' && trusted.tenantId === tenantId) {
    return { ok: true, scope: trusted };
  }
  return {
    ok: false,
    message:
      'The requested tenant is outside the runtime diagnostic scope configured by the MCP host.',
  };
}

function staticOnly(scope: TrustedSystemDiagnosticScope): StaticOnlyResult {
  return {
    status: 'not-configured',
    mode: 'static-only',
    provenance: {
      source: 'static-only',
      observation: 'none',
      observedAt: new Date().toISOString(),
      connectionSource: null,
      scope,
    },
    data: null,
    diagnostics: [
      {
        severity: 'info',
        code: 'runtime-not-configured',
        message:
          'No runtime database connection is configured; static development tools remain available.',
      },
    ],
  };
}

function connectionUnavailable(
  scope: TrustedSystemDiagnosticScope,
  source: ConnectionUnavailableResult['provenance']['connectionSource'],
  code: string,
  message: string,
): ConnectionUnavailableResult {
  return {
    status: 'unavailable',
    mode: 'runtime',
    provenance: {
      source: 'runtime',
      observation: 'connection-failed',
      observedAt: new Date().toISOString(),
      connectionSource: source,
      scope,
    },
    data: null,
    diagnostics: [{ severity: 'warning', code, message }],
  };
}

function packageDatabaseConfig(config: unknown): {
  url?: string;
  type?: unknown;
} | null {
  if (!isRecord(config) || !isRecord(config.packages)) return null;
  const cli = config.packages.cli;
  if (!isRecord(cli) || !isRecord(cli.database)) return null;
  return {
    url: nonEmptyString(cli.database.url) ? cli.database.url.trim() : undefined,
    type: cli.database.type,
  };
}

function inferEngine(url: string): SystemDiagnosticEngine | undefined {
  if (/^postgres(?:ql)?:\/\//i.test(url)) return 'postgres';
  if (url === ':memory:' || /^file:/i.test(url)) return 'sqlite';
  if (/^duckdb:/i.test(url)) return 'duckdb';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return 'sqlite';
  return undefined;
}

function normalizeDatabaseUrl(
  url: string,
  engine: SystemDiagnosticEngine,
  rootDir: string,
): string {
  if (engine === 'postgres' || url === ':memory:') return url;
  if (engine === 'duckdb' && url.startsWith('duckdb:')) {
    const suffix = url.slice('duckdb:'.length);
    if (/^\/{0,3}:memory:$/.test(suffix)) return ':memory:';
    if (suffix.startsWith('///')) return `/${suffix.slice(3)}`;
    if (suffix.startsWith('//')) return resolve(rootDir, suffix.slice(2));
    return isAbsolute(suffix) ? suffix : resolve(rootDir, suffix);
  }
  if (url.startsWith('file:')) {
    const filePath = url.slice('file:'.length);
    return isAbsolute(filePath) ? url : `file:${resolve(rootDir, filePath)}`;
  }
  const localPath = url;
  if (isAbsolute(localPath) || /^[a-z][a-z0-9+.-]*:/i.test(localPath)) {
    return localPath;
  }
  return resolve(rootDir, localPath);
}

async function validateDatabaseTarget(
  url: string,
  engine: SystemDiagnosticEngine,
  injectedConnection: boolean,
): Promise<
  { ok: true; url: string } | { ok: false; code: string; message: string }
> {
  if (engine === 'postgres' || isRemoteDatabaseUrl(url)) {
    return { ok: true, url };
  }
  if (url === ':memory:') {
    return injectedConnection
      ? { ok: true, url }
      : {
          ok: false,
          code: 'ephemeral-database-unsupported',
          message:
            'Runtime diagnostics require an existing database; an isolated in-memory database has no runtime state.',
        };
  }

  const path = localDatabasePath(url);
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
  } catch {
    return {
      ok: false,
      code: 'database-file-unavailable',
      message:
        'The configured local database does not exist as a regular file; runtime diagnostics will not create it.',
    };
  }
  return { ok: true, url };
}

function isRemoteDatabaseUrl(url: string): boolean {
  return /^(?:https?|libsql):\/\//i.test(url);
}

function localDatabasePath(url: string): string {
  if (!url.startsWith('file:')) return url;
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) {
    throw new Error('SQLite file URLs with parameters are not supported.');
  }
  return fileURLToPath(parsed);
}

async function closeDatabase(db: DatabaseInterface): Promise<void> {
  const client = db.client as
    | {
        close?: () => void | Promise<void>;
        end?: () => void | Promise<void>;
      }
    | undefined;
  try {
    if (typeof client?.close === 'function') {
      await client.close.call(client);
    } else if (typeof client?.end === 'function') {
      await client.end.call(client);
    }
  } catch {
    // Diagnostics are already complete. Shutdown errors must not corrupt their
    // result or leak adapter details across the MCP boundary.
  }
}

function supportedEngine(value: unknown): SystemDiagnosticEngine | undefined {
  return value === 'sqlite' || value === 'postgres' || value === 'duckdb'
    ? value
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

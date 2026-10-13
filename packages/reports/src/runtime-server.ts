/** Server-owned authority and browser confirmation for runtime reports. */
import { getPackageConfig } from '@happyvertical/smrt-config';
import { runOnce } from '@happyvertical/smrt-core';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  compileRuntimeReportSpec,
  type RuntimeReportCompileContext,
  type RuntimeReportResult,
  type RuntimeReportSourceDefinition,
} from './runtime-compiler.js';
import {
  getRuntimeReport,
  listRuntimeReports,
  runStoredRuntimeReport,
  saveRuntimeReport,
} from './runtime-report.js';
import {
  parseRuntimeReportSpec,
  RuntimeReportError,
  type RuntimeReportSpec,
  runtimeReportSpecHash,
} from './runtime-spec.js';

/** Browser proposal; carries data, never proof or permission to write. */
export interface RuntimeReportAwaitingConfirmation {
  status: 'awaiting_confirmation';
  specHash: string;
  spec: RuntimeReportSpec;
  sourceLabel: string;
  preview: RuntimeReportResult;
  confirmPath: string;
}

/** Trusted session principal and its request-scoped database/transaction. */
export interface RuntimeReportPrincipal {
  db: DatabaseInterface;
  userId: string;
  tenantId: string;
  permissions: readonly string[];
}

/** A source must declare its permission-catalog slug, never a class name. */
export interface RuntimeReportServerSource
  extends RuntimeReportSourceDefinition {
  collection: string;
}

/** Host-owned configuration; never read it from a request body. */
export interface RuntimeReportServerOptions {
  sources: readonly RuntimeReportServerSource[];
  /** Called after a confirmed save (including a successful retry). */
  audit?: (entry: {
    action: 'confirm';
    userId: string;
    tenantId: string;
    specHash: string;
    reportId: string;
    reused: boolean;
  }) => unknown;
}

/** Public action failure with a stable HTTP status and code. */
export class RuntimeReportHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeReportHttpError';
  }
}

/** Require an authenticated tenant principal; do not honor system bypass. */
export function assertRuntimeReportPrincipal(
  context: RuntimeReportPrincipal | null | undefined,
  permission: string,
): asserts context is RuntimeReportPrincipal {
  if (!context?.userId) {
    throw new RuntimeReportHttpError(
      401,
      'unauthenticated',
      'Sign in required',
    );
  }
  const active = getCurrentTenant();
  if (
    !context.tenantId ||
    (active && active.tenantId !== context.tenantId) ||
    (active?.userId && active.userId !== context.userId) ||
    !context.permissions.includes(permission)
  ) {
    throw new RuntimeReportHttpError(403, 'forbidden', 'Report access denied');
  }
}

/** Narrow sources before compilation so hidden source ids cannot be probed. */
export function runtimeReportPrincipalCompileContext(
  options: RuntimeReportServerOptions,
  principal: RuntimeReportPrincipal,
): RuntimeReportCompileContext {
  return {
    sources: options.sources.filter((source) =>
      principal.permissions.includes(`${source.collection}.read`),
    ),
    permissions: principal.permissions,
    tenantId: principal.tenantId,
  };
}

/**
 * Mount at POST /api/_reports/runtime/confirm. Context must come from the
 * verified server session, never the JSON body. The same request executor is
 * used for lookup and save, preserving an enclosing RLS transaction.
 */
export function createRuntimeReportConfirmHandler(
  options?: RuntimeReportServerOptions,
): (
  request: Request,
  context: RuntimeReportPrincipal | null | undefined,
) => Promise<Response> {
  return async (request, context) => {
    try {
      if (request.method !== 'POST') {
        return Response.json(
          { code: 'method_not_allowed' },
          {
            status: 405,
            headers: { Allow: 'POST' },
          },
        );
      }
      const origin = request.headers.get('origin');
      const site = request.headers.get('sec-fetch-site');
      if (
        (origin !== null && origin !== new URL(request.url).origin) ||
        (site !== null && site !== 'same-origin') ||
        (origin === null && site !== 'same-origin')
      ) {
        throw new RuntimeReportHttpError(
          403,
          'cross_origin',
          'Same-origin request required',
        );
      }
      assertRuntimeReportPrincipal(context, 'runtimereports.create');
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new RuntimeReportHttpError(
          422,
          'invalid_spec',
          'Invalid JSON body',
        );
      }
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'spec' && key !== 'specHash')
      ) {
        throw new RuntimeReportHttpError(
          422,
          'invalid_spec',
          'Expected spec and specHash',
        );
      }
      const input = body as { spec?: unknown; specHash?: unknown };
      const spec = parseRuntimeReportSpec(input.spec);
      const hash = runtimeReportSpecHash(spec);
      if (input.specHash !== hash) {
        throw new RuntimeReportHttpError(
          422,
          'spec_hash_mismatch',
          'The approved spec hash does not match',
        );
      }
      const principal = context;
      return await withTenant(
        {
          tenantId: principal.tenantId,
          userId: principal.userId,
          permissions: new Set(principal.permissions),
        },
        async () => {
          const serverOptions = options ?? getRuntimeReportServerOptions();
          // Compile even a retry: previously saved data grants no current authority.
          const compiled = await compileRuntimeReportSpec(
            spec,
            runtimeReportPrincipalCompileContext(serverOptions, principal),
          );
          const transaction = principal.db.transaction?.bind(principal.db);
          if (!transaction) {
            throw new RuntimeReportHttpError(
              500,
              'transaction_required',
              'Runtime report confirmation requires transaction support',
            );
          }
          // Read the active definition and retry generation in one snapshot.
          // Embedded adapters serialize this transaction with the durable claim;
          // an unscoped lookup could otherwise overlap a pending DuckDB query.
          const { existing, archived } = await transaction(async (tx) => {
            const lookup = {
              db: tx,
              tenantId: principal.tenantId,
              createdByUserId: principal.userId,
              specHash: hash,
              limit: 1,
            };
            const [existing] = await listRuntimeReports(lookup);
            const [archived] = existing
              ? []
              : await listRuntimeReports({
                  ...lookup,
                  status: 'archived',
                });
            return { existing, archived };
          });
          let created = false;
          let report = existing
            ? { id: existing.id, specHash: hash, title: existing.title }
            : undefined;
          if (!report && archived) {
            throw new RuntimeReportHttpError(
              409,
              'report_archived',
              'Restore the archived report before confirming it again',
            );
          }
          if (!report) {
            // The durable claim serializes simultaneous confirms across hosts.
            report = await runOnce(
              {
                db: principal.db,
                tenantId: principal.tenantId,
                actor: principal.userId,
                token: 'runtime-report-confirm',
                content: spec,
              },
              async (tx) => {
                // An in-process host may have saved between the outer lookup and
                // this transaction. It uses the same active-author/hash identity.
                const [current] = await listRuntimeReports({
                  db: tx,
                  tenantId: principal.tenantId,
                  createdByUserId: principal.userId,
                  specHash: hash,
                  limit: 1,
                });
                const saved =
                  current ??
                  (await saveRuntimeReport({
                    db: tx,
                    tenantId: principal.tenantId,
                    createdByUserId: principal.userId,
                    compiled,
                    confirmedSpecHash: hash,
                  }));
                created = !current;
                if (!saved.id) throw new Error('Saved report has no id');
                return { id: saved.id, specHash: hash, title: saved.title };
              },
            );
          }
          if (!report.id) throw new Error('Saved report has no id');
          await serverOptions.audit?.({
            action: 'confirm',
            userId: principal.userId,
            tenantId: principal.tenantId,
            specHash: hash,
            reportId: report.id,
            reused: !created,
          });
          return Response.json(
            { id: report.id, specHash: hash, title: report.title },
            {
              status: created ? 201 : 200,
              headers: { 'Cache-Control': 'no-store' },
            },
          );
        },
      );
    } catch (error) {
      if (
        error instanceof RuntimeReportHttpError ||
        error instanceof RuntimeReportError
      ) {
        return Response.json(
          { code: error.code, message: error.message },
          {
            status: error instanceof RuntimeReportError ? 422 : error.status,
            headers: { 'Cache-Control': 'no-store' },
          },
        );
      }
      // Database/provider errors can contain connection details; never echo them.
      return Response.json(
        { code: 'internal_error', message: 'Unable to confirm report' },
        {
          status: 500,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }
  };
}

/** Runtime source allow-list configured in packages.reports.runtime.sources. */
export function getRuntimeReportServerOptions(): RuntimeReportServerOptions {
  const config = getPackageConfig<{ runtime?: RuntimeReportServerOptions }>(
    'reports',
  );
  return config.runtime ?? { sources: [] };
}

/** Obtain authority from the authenticated execution scope, never model options. */
export function currentRuntimeReportPrincipal(
  db: DatabaseInterface,
): RuntimeReportPrincipal {
  const context = getCurrentTenant();
  return {
    db,
    userId: context?.userId ?? '',
    tenantId: context?.tenantId ?? '',
    permissions: [...(context?.permissions ?? [])],
  };
}

/** Run a saved report as this viewer, without persisting result rows. */
export async function runRuntimeReportForPrincipal(
  ref: string,
  principal: RuntimeReportPrincipal,
  options: RuntimeReportServerOptions = getRuntimeReportServerOptions(),
): Promise<RuntimeReportResult> {
  assertRuntimeReportPrincipal(principal, 'runtimereports.read');
  return withTenant(
    {
      tenantId: principal.tenantId,
      userId: principal.userId,
      permissions: new Set(principal.permissions),
    },
    async () => {
      const report = await getRuntimeReport({
        db: principal.db,
        ref,
        tenantId: principal.tenantId,
      });
      if (!report)
        throw new RuntimeReportHttpError(404, 'not_found', 'Report not found');
      try {
        return await runStoredRuntimeReport({
          db: principal.db,
          report,
          context: runtimeReportPrincipalCompileContext(options, principal),
        });
      } catch (error) {
        if (error instanceof RuntimeReportError) {
          if (
            error.code === 'unknown_field' ||
            error.code === 'unknown_source'
          ) {
            throw new RuntimeReportHttpError(
              403,
              'forbidden',
              'Report access denied',
            );
          }
          throw new RuntimeReportHttpError(422, error.code, error.message);
        }
        throw error;
      }
    },
  );
}

/** Change only the saved status under the tenant writer's authority. */
export async function archiveRuntimeReportForPrincipal(
  ref: string,
  archived: boolean,
  principal: RuntimeReportPrincipal,
): Promise<{ id: string; status: 'active' | 'archived' }> {
  assertRuntimeReportPrincipal(principal, 'runtimereports.create');
  if (typeof archived !== 'boolean') {
    throw new RuntimeReportHttpError(
      422,
      'invalid_value',
      'archived must be a boolean',
    );
  }
  return withTenant(
    {
      tenantId: principal.tenantId,
      userId: principal.userId,
      permissions: new Set(principal.permissions),
    },
    async () => {
      const report = await getRuntimeReport({
        db: principal.db,
        ref,
        tenantId: principal.tenantId,
      });
      if (!report?.id)
        throw new RuntimeReportHttpError(404, 'not_found', 'Report not found');
      const status = archived ? 'archived' : 'active';
      if (report.status !== status) {
        report.status = status;
        await report.save();
      }
      return { id: report.id, status };
    },
  );
}

/** Recipe loader; context.reportPrincipal is supplied by the server host. */
export async function loadRuntimeReportChart(
  options: Record<string, unknown>,
  context: { reportPrincipal?: RuntimeReportPrincipal; currency?: string },
): Promise<{
  points: { label: string; value: number }[];
  format: 'integer' | 'decimal' | 'money';
  currency?: string;
  href: string;
}> {
  assertRuntimeReportPrincipal(context.reportPrincipal, 'runtimereports.read');
  if (
    typeof options.reportId !== 'string' ||
    typeof options.measure !== 'string'
  ) {
    throw new RuntimeReportHttpError(
      422,
      'invalid_value',
      'Select a report and measure',
    );
  }
  const result = await runRuntimeReportForPrincipal(
    options.reportId,
    context.reportPrincipal,
  );
  const measure = result.columns.find(
    (column) => column.id === options.measure && column.role === 'measure',
  );
  const dimension =
    options.dimension === undefined
      ? result.columns.find((column) => column.role === 'dimension')
      : result.columns.find(
          (column) =>
            column.id === options.dimension && column.role === 'dimension',
        );
  if (!measure || (options.dimension !== undefined && !dimension)) {
    throw new RuntimeReportHttpError(
      422,
      'invalid_value',
      'Invalid report measure or dimension',
    );
  }
  const points = result.rows.map((row) => {
    const value = row[measure.id];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RuntimeReportHttpError(
        422,
        'invalid_result',
        'Chart requires numeric measures',
      );
    }
    return {
      label: dimension ? String(row[dimension.id] ?? '') : result.title,
      value,
    };
  });
  return {
    points,
    format:
      measure.format === 'money'
        ? 'money'
        : measure.type === 'integer'
          ? 'integer'
          : 'decimal',
    ...(context.currency ? { currency: context.currency } : {}),
    href: `/reports/${encodeURIComponent(options.reportId)}`,
  };
}

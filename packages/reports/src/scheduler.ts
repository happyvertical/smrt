import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  field,
  GlobalInterceptors,
  type InterceptorContext,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  backgroundEligible,
  type DurableJobPayloadIntegrity,
  type DurableJobPayloadSigner,
  getNextCronDate,
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
  validateCronExpression,
} from '@happyvertical/smrt-jobs';
import {
  getTenantId,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface, SqlAdapterType } from '@happyvertical/sql';
import { buildReportDefinition } from './compiler.js';
import { refreshReport } from './refresh.js';
import {
  assertReportTablesReady,
  REPORT_SCHEDULER_TABLES,
  REPORT_SCHEDULES_TABLE,
  scopeKeyForTenant,
} from './state.js';
import type {
  ReportDefinition,
  ReportRefreshMode,
  ReportRefreshTrigger,
  ReportSource,
} from './types.js';

type ReportCtor = new (...args: any[]) => SmrtObject;

export interface ReportRefreshJobArgs {
  reportClass?: string;
  mode?: ReportRefreshMode;
  trigger?: ReportRefreshTrigger;
  tenantId?: string | null;
  tenantIds?: string[];
  scheduleId?: string;
  adapterType?: SqlAdapterType;
  changedRows?: Record<string, unknown>[];
  _scheduleId?: string;
  executionAuthority?: ReportRefreshExecutionAuthority;
  integrity?: DurableJobPayloadIntegrity;
}

export interface ReportExecutionPrincipalReference {
  version: 1;
  actorUserId: string;
  tenantId: string | null;
  onBehalfOfUserId?: string | null;
  actsAsProfileId?: string | null;
  agentClass?: string | null;
}

export interface ReportRefreshExecutionAuthority {
  version: 1;
  hostId: string;
  principal: ReportExecutionPrincipalReference;
}

export interface ReportRefreshExecutionAuthorityContext {
  phase: 'execute';
  reportClass: string;
  mode: ReportRefreshMode;
  trigger: ReportRefreshTrigger;
  tenantId: string | null;
}

export interface ReportRefreshExecutionAuditEvent
  extends ReportRefreshExecutionAuthorityContext {
  outcome: 'allowed' | 'denied';
  principal: ReportExecutionPrincipalReference;
  reason?: string;
}

export interface ReportRefreshExecutionAuthorityHost {
  authorize(
    principal: Readonly<ReportExecutionPrincipalReference>,
    context: Readonly<ReportRefreshExecutionAuthorityContext>,
  ): Promise<void> | void;
  audit(
    event: Readonly<ReportRefreshExecutionAuditEvent>,
  ): Promise<void> | void;
}

export interface EnqueueReportRefreshOptions extends ReportRefreshJobArgs {
  report?: ReportCtor;
  reportClass: string;
  db: DatabaseInterface;
  queue?: string;
  priority?: number;
  timeout?: number;
  maxAttempts?: number;
  tenantJobCap?: number;
  /** Server-only signer; register the same key in every worker process. */
  integritySigner?: DurableJobPayloadSigner;
}

export interface EnsureReportSchedulesOptions {
  db: DatabaseInterface;
  reports: ReportCtor[];
  tenantIds?: string[];
  queue?: string;
  priority?: number;
  timeout?: number;
}

export interface ReportScheduleRunnerConfig {
  id?: string;
  pollInterval?: number;
  batchSize?: number;
  integritySigner?: DurableJobPayloadSigner;
}

export interface ReportScheduleInfo {
  id: string;
  reportClass: string;
  tenantId: string | null;
  cron: string;
  mode: ReportRefreshMode;
}

export interface ReportScheduleRunnerEvents {
  'schedule:triggered': (schedule: ReportScheduleInfo) => void;
  'schedule:error': (schedule: ReportScheduleInfo, error: Error) => void;
  'schedule:completed': (scheduleId: string) => void;
  'schedule:failed': (scheduleId: string, error: string) => void;
  'runner:started': () => void;
  'runner:stopped': () => void;
  'runner:error': (error: Error) => void;
}

export interface ReportRefreshInterceptorOptions {
  db: DatabaseInterface;
  reports: ReportCtor[];
  enqueue?: boolean;
  queue?: string;
  priority?: number;
  timeout?: number;
  tenantJobCap?: number;
  name?: string;
  integritySigner?: DurableJobPayloadSigner;
}

const INTERNAL_SURFACE = {
  api: false,
  cli: {
    include: ['list', 'get'],
    skipApiCheck: true,
    http: false,
  },
  mcp: false,
};

const executionAuthorityHosts = new Map<
  string,
  ReportRefreshExecutionAuthorityHost
>();
const jobIntegritySigners = new Map<string, DurableJobPayloadSigner>();

export function registerReportRefreshJobIntegritySigner(
  signer: DurableJobPayloadSigner,
): () => void {
  const existing = jobIntegritySigners.get(signer.keyId);
  if (existing && existing !== signer) {
    throw new Error(
      `Report refresh job integrity signer already registered: ${signer.keyId}`,
    );
  }
  jobIntegritySigners.set(signer.keyId, signer);
  return () => {
    if (jobIntegritySigners.get(signer.keyId) === signer) {
      jobIntegritySigners.delete(signer.keyId);
    }
  };
}

function unsignedReportRefreshJobArgs(
  args: ReportRefreshJobArgs,
): Omit<ReportRefreshJobArgs, 'integrity'> {
  const {
    integrity: _integrity,
    _scheduleId: _internalScheduleId,
    ...unsigned
  } = args;
  return unsigned;
}

function assertReportRefreshJobIntegrity(args: ReportRefreshJobArgs): void {
  const integrity = args.integrity;
  const signer = integrity
    ? jobIntegritySigners.get(integrity.keyId)
    : undefined;
  if (
    !integrity ||
    !signer?.verify(unsignedReportRefreshJobArgs(args), integrity)
  ) {
    throw new Error('Invalid durable report refresh job integrity binding');
  }
}

function assertReportRefreshJobTarget(
  args: ReportRefreshJobArgs,
  context: JobExecutionContext | undefined,
): void {
  if (!context) return;
  const expectedType = canonicalClassName(
    (args.trigger ?? 'job') === 'manual'
      ? SmrtPrincipalReportRefreshTask
      : SmrtReportRefreshTask,
  );
  if (context.job.objectType !== expectedType || context.job.method !== 'run') {
    throw new Error('Invalid durable report refresh job target');
  }
}

export function registerReportRefreshExecutionAuthorityHost(
  hostId: string,
  host: ReportRefreshExecutionAuthorityHost,
): () => void {
  if (!hostId || hostId.length > 256) {
    throw new Error(
      'Report refresh authority hostId must contain 1-256 characters',
    );
  }
  const existing = executionAuthorityHosts.get(hostId);
  if (existing && existing !== host) {
    throw new Error(
      `Report refresh authority host already registered: ${hostId}`,
    );
  }
  executionAuthorityHosts.set(hostId, host);
  return () => {
    if (executionAuthorityHosts.get(hostId) === host) {
      executionAuthorityHosts.delete(hostId);
    }
  };
}

function stableUuid(values: unknown[]): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex');
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function canonicalClassName(reportCtor: ReportCtor): string {
  const registered =
    ObjectRegistry.getClassByConstructor(reportCtor) ??
    ObjectRegistry.getClass(reportCtor.name);
  return registered?.qualifiedName ?? registered?.name ?? reportCtor.name;
}

function resolveReportClass(name: string): ReportCtor {
  const registered =
    ObjectRegistry.getClassByQualifiedName(name) ??
    ObjectRegistry.getClass(name);
  if (!registered) {
    throw new Error(`Unknown report class: ${name}`);
  }
  return registered.constructor as unknown as ReportCtor;
}

function reportSourceName(source: ReportSource): string {
  if (typeof source === 'string') return source;
  return source.name;
}

function sourceMatches(
  definition: ReportDefinition,
  instance: SmrtObject,
  context: InterceptorContext,
): boolean {
  const configured = definition.refresh?.onChange;
  if (!configured || configured.length === 0) return false;

  const eventNames = new Set<string>([
    context.className,
    instance.constructor.name,
  ]);
  const registered = ObjectRegistry.getClassByConstructor(
    instance.constructor as ReportCtor,
  );
  if (registered?.qualifiedName) eventNames.add(registered.qualifiedName);
  if (registered?.name) eventNames.add(registered.name);

  for (const source of configured) {
    const name = reportSourceName(source);
    const registeredSource =
      ObjectRegistry.getClassByQualifiedName(name) ??
      ObjectRegistry.getClass(name);
    if (
      eventNames.has(name) ||
      (registeredSource?.name && eventNames.has(registeredSource.name)) ||
      (registeredSource?.qualifiedName &&
        eventNames.has(registeredSource.qualifiedName))
    ) {
      return true;
    }
  }

  return false;
}

function tenantIdFromInstance(instance: SmrtObject): string | null {
  const value = (instance as unknown as { tenantId?: unknown }).tenantId;
  return typeof value === 'string' && value.length > 0
    ? value
    : (getTenantId() ?? null);
}

function changedRowSnapshot(instance: SmrtObject): Record<string, unknown> {
  const serializable = instance.toJSON();
  return serializable && typeof serializable === 'object'
    ? (serializable as Record<string, unknown>)
    : {};
}

async function authorizeReportRefreshExecution(
  args: ReportRefreshJobArgs,
  reportClass: string,
  jobTenantId: string | null,
): Promise<void> {
  if ((args.tenantId ?? null) !== jobTenantId) {
    throw new Error('Invalid report refresh execution tenant');
  }
  const authority = args.executionAuthority;
  if ((args.trigger ?? 'job') === 'manual' && !authority) {
    throw new Error('Manual report refresh execution authority is missing');
  }
  // Scheduled and on-change maintenance jobs predate user-bound actions and
  // intentionally run under the worker's system authority.
  if (!authority) return;
  const principal = authority.principal;
  const tenantId = args.tenantId ?? null;
  if (
    authority.version !== 1 ||
    principal?.version !== 1 ||
    !authority.hostId ||
    !principal.actorUserId ||
    principal.tenantId !== tenantId ||
    principal.tenantId !== jobTenantId
  ) {
    throw new Error('Invalid report refresh execution authority');
  }
  const host = executionAuthorityHosts.get(authority.hostId);
  if (!host) {
    throw new Error(
      `No report refresh authority host registered for ${authority.hostId}`,
    );
  }
  const context: ReportRefreshExecutionAuthorityContext = {
    phase: 'execute',
    reportClass,
    mode: args.mode ?? 'incremental',
    trigger: args.trigger ?? 'job',
    tenantId,
  };
  try {
    await host.authorize(
      Object.freeze({ ...principal }),
      Object.freeze(context),
    );
  } catch {
    await host.audit({
      ...context,
      outcome: 'denied',
      principal: Object.freeze({ ...principal }),
      reason: 'current_authority_denied',
    });
    throw new Error('Report refresh execution authority denied');
  }
  await host.audit({
    ...context,
    outcome: 'allowed',
    principal: Object.freeze({ ...principal }),
  });
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_report_refresh_tasks',
  ...INTERNAL_SURFACE,
})
export class SmrtReportRefreshTask extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', required: true })
  reportClass: string = '';

  @field({ type: 'text', required: true })
  mode: ReportRefreshMode = 'incremental';

  @field({ type: 'text', required: true })
  trigger: ReportRefreshTrigger = 'job';

  @field({ type: 'json' })
  args: ReportRefreshJobArgs = {};

  @backgroundEligible()
  async run(
    args: ReportRefreshJobArgs = {},
    context?: JobExecutionContext,
  ): Promise<unknown> {
    assertReportRefreshJobIntegrity(args);
    assertReportRefreshJobTarget(args, context);
    const reportClass = args.reportClass;
    if (!reportClass) {
      throw new Error('Report refresh job requires reportClass');
    }
    const mode = args.mode ?? 'incremental';
    const trigger = args.trigger ?? 'job';

    const reportCtor = resolveReportClass(reportClass);
    const jobTenantId = context?.job.tenantId ?? tenantIdFromInstance(this);
    await authorizeReportRefreshExecution(args, reportClass, jobTenantId);
    return refreshReport(reportCtor, {
      db: this.db,
      mode,
      trigger,
      tenantId: args.tenantId,
      tenantIds: args.tenantIds,
      adapterType: args.adapterType,
      scheduleId: args.scheduleId ?? args._scheduleId,
      changedRows: args.changedRows,
    });
  }
}

/** Worker target whose authority requirement cannot be downgraded by job args. */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_principal_report_refresh_tasks',
  ...INTERNAL_SURFACE,
})
export class SmrtPrincipalReportRefreshTask extends SmrtReportRefreshTask {
  override async run(
    args: ReportRefreshJobArgs = {},
    context?: JobExecutionContext,
  ): Promise<unknown> {
    return super.run({ ...args, trigger: 'manual' }, context);
  }
}

export async function enqueueReportRefresh(
  options: EnqueueReportRefreshOptions,
): Promise<SmrtJob> {
  if (!options.integritySigner) {
    throw new Error(
      'Report refresh queue requires a durable job integrity signer',
    );
  }
  if (options.trigger === 'manual' && !options.executionAuthority) {
    throw new Error('Manual report refresh requires execution-time authority');
  }
  if (
    options.executionAuthority &&
    (options.executionAuthority.version !== 1 ||
      options.executionAuthority.principal?.version !== 1 ||
      !options.executionAuthority.hostId ||
      !options.executionAuthority.principal.actorUserId ||
      options.executionAuthority.principal.tenantId !==
        (options.tenantId ?? null))
  ) {
    throw new Error('Invalid report refresh execution authority');
  }
  if (
    options.executionAuthority &&
    (options.trigger !== 'manual' || (options.tenantIds?.length ?? 0) > 0)
  ) {
    throw new Error(
      'Principal-bound report refresh requires one manual tenant scope',
    );
  }
  await ObjectRegistry.ensureManifestLoaded('SmrtJob');
  const collection = await SmrtJobCollection.create({ db: options.db });
  const taskType = canonicalClassName(
    options.trigger === 'manual'
      ? SmrtPrincipalReportRefreshTask
      : SmrtReportRefreshTask,
  );
  const scheduleId = options.scheduleId ?? options._scheduleId;

  const unsignedArgs: Omit<ReportRefreshJobArgs, 'integrity'> = {
    reportClass: options.reportClass,
    mode: options.mode ?? 'incremental',
    trigger: options.trigger ?? 'job',
    tenantId: options.tenantId,
    tenantIds: options.tenantIds,
    adapterType: options.adapterType,
    changedRows: options.changedRows,
    scheduleId,
    executionAuthority: options.executionAuthority,
  };
  const integrity = options.integritySigner.sign(unsignedArgs);
  if (
    !jobIntegritySigners.get(integrity.keyId)?.verify(unsignedArgs, integrity)
  ) {
    throw new Error(
      'Report refresh job integrity signer must be registered before enqueue',
    );
  }
  return collection.enqueueJob(
    {
      tenantId: options.tenantId ?? null,
      queue: options.queue ?? 'reports',
      objectType: taskType,
      objectId: null,
      method: 'run',
      args: { ...unsignedArgs, _scheduleId: scheduleId, integrity },
      priority: options.priority ?? 70,
      timeout: options.timeout ?? 3600000,
      maxAttempts: options.maxAttempts ?? 3,
    },
    { tenantJobCap: options.tenantJobCap },
  );
}

export async function ensureReportRefreshSchedules(
  options: EnsureReportSchedulesOptions,
): Promise<void> {
  await assertReportTablesReady(options.db, REPORT_SCHEDULER_TABLES);

  for (const reportCtor of options.reports) {
    const definition = await buildReportDefinition(reportCtor);
    const refresh = definition.refresh;
    if (!refresh || refresh.manual) continue;

    const reportClass = canonicalClassName(reportCtor);
    const targetTenants = refresh.tenantFanout
      ? options.tenantIds
      : [null as string | null];
    if (
      refresh.tenantFanout &&
      (!targetTenants || targetTenants.length === 0)
    ) {
      throw new Error(
        `${definition.reportClassName} refresh.tenantFanout requires tenantIds when creating schedules.`,
      );
    }

    const schedules = [
      refresh.schedule
        ? {
            cron: refresh.schedule,
            mode: refresh.mode ?? 'incremental',
            trigger: 'schedule' as const,
          }
        : null,
      refresh.fullRebuildSchedule
        ? {
            cron: refresh.fullRebuildSchedule,
            mode: 'rebuild' as const,
            trigger: 'schedule' as const,
          }
        : null,
    ].filter(Boolean) as Array<{
      cron: string;
      mode: ReportRefreshMode;
      trigger: ReportRefreshTrigger;
    }>;

    for (const schedule of schedules) {
      validateCronExpression(schedule.cron);
      for (const tenantId of targetTenants ?? []) {
        const scopeKey = scopeKeyForTenant(tenantId);
        const id = stableUuid([
          'schedule',
          reportClass,
          scopeKey,
          schedule.cron,
          schedule.mode,
        ]);
        const now = new Date().toISOString();
        await options.db.upsert(
          REPORT_SCHEDULES_TABLE,
          ['report_class', 'scope_key', 'cron', 'mode'],
          {
            id,
            slug: id,
            context: scopeKey,
            tenant_id: tenantId,
            scope_key: scopeKey,
            report_class: reportClass,
            cron: schedule.cron,
            trigger: schedule.trigger,
            mode: schedule.mode,
            enabled: true,
            status: 'active',
            next_run: getNextCronDate(schedule.cron).toISOString(),
            last_run: null,
            last_status: null,
            last_error: null,
            run_count: 0,
            success_count: 0,
            failure_count: 0,
            running_count: 0,
            max_concurrent: 1,
            queue: options.queue ?? 'reports',
            priority: options.priority ?? 70,
            timeout: options.timeout ?? 3600000,
            created_at: now,
            updated_at: now,
          },
        );
      }
    }
  }
}

export class ReportScheduleRunner extends EventEmitter {
  readonly id: string;
  private readonly config: Required<
    Omit<ReportScheduleRunnerConfig, 'integritySigner'>
  > &
    Pick<ReportScheduleRunnerConfig, 'integritySigner'>;
  private db: DatabaseInterface | null = null;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config: ReportScheduleRunnerConfig = {}) {
    super();
    this.config = {
      id: config.id || `reports_${stableUuid([Date.now()]).slice(0, 8)}`,
      pollInterval: config.pollInterval ?? 60000,
      batchSize: config.batchSize ?? 50,
      integritySigner: config.integritySigner,
    };
    this.id = this.config.id;
  }

  async initialize(db: DatabaseInterface): Promise<void> {
    this.db = db;
    await assertReportTablesReady(db, REPORT_SCHEDULER_TABLES);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.db) {
      throw new Error(
        'ReportScheduleRunner not initialized. Call initialize() first.',
      );
    }
    this.running = true;
    this.startPolling();
    this.emit('runner:started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.emit('runner:stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  async handleJobCompletion(
    scheduleId: string,
    success: boolean,
    errorMessage?: string,
  ): Promise<void> {
    if (!this.db) return;
    const now = new Date().toISOString();
    if (success) {
      await this.db.query(
        `UPDATE ${REPORT_SCHEDULES_TABLE}
            SET running_count = CASE WHEN COALESCE(running_count, 0) > 0 THEN running_count - 1 ELSE 0 END,
                last_run = ?,
                last_status = 'success',
                last_error = NULL,
                run_count = COALESCE(run_count, 0) + 1,
                success_count = COALESCE(success_count, 0) + 1,
                updated_at = ?
          WHERE id = ?`,
        now,
        now,
        scheduleId,
      );
      this.emit('schedule:completed', scheduleId);
      return;
    }

    const safeError = errorMessage ?? 'Unknown error';
    await this.db.query(
      `UPDATE ${REPORT_SCHEDULES_TABLE}
          SET running_count = CASE WHEN COALESCE(running_count, 0) > 0 THEN running_count - 1 ELSE 0 END,
              last_run = ?,
              last_status = 'failed',
              last_error = ?,
              run_count = COALESCE(run_count, 0) + 1,
              failure_count = COALESCE(failure_count, 0) + 1,
              updated_at = ?
        WHERE id = ?`,
      now,
      safeError,
      now,
      scheduleId,
    );
    this.emit('schedule:failed', scheduleId, safeError);
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.running) return;
      try {
        await this.poll();
      } catch (error) {
        this.emit('runner:error', error as Error);
      }
      if (this.running) {
        this.pollTimer = setTimeout(poll, this.config.pollInterval);
        if (typeof this.pollTimer.unref === 'function') {
          this.pollTimer.unref();
        }
      }
    };
    poll();
  }

  async poll(): Promise<void> {
    if (!this.db) return;
    const result = await this.db.query(
      `SELECT * FROM ${REPORT_SCHEDULES_TABLE}
        WHERE enabled = true
          AND status = 'active'
          AND next_run <= ?
          AND COALESCE(running_count, 0) < COALESCE(max_concurrent, 1)
        ORDER BY next_run ASC
        LIMIT ?`,
      new Date().toISOString(),
      this.config.batchSize,
    );

    for (const row of result.rows) {
      await this.triggerSchedule(row as ReportScheduleRow);
    }
  }

  private async triggerSchedule(row: ReportScheduleRow): Promise<void> {
    if (!this.db) return;
    const schedule: ReportScheduleInfo = {
      id: String(row.id),
      reportClass: String(row.report_class),
      tenantId:
        typeof row.tenant_id === 'string' && row.tenant_id.length > 0
          ? row.tenant_id
          : null,
      cron: String(row.cron),
      mode: (row.mode as ReportRefreshMode) || 'incremental',
    };

    try {
      const nextRun = getNextCronDate(schedule.cron);
      await enqueueReportRefresh({
        db: this.db,
        reportClass: schedule.reportClass,
        mode: schedule.mode,
        trigger: (row.trigger as ReportRefreshTrigger) || 'schedule',
        tenantId: schedule.tenantId,
        scheduleId: schedule.id,
        queue: String(row.queue || 'reports'),
        priority: Number(row.priority ?? 70),
        timeout: Number(row.timeout ?? 3600000),
        integritySigner: this.config.integritySigner,
      });
      await this.db.query(
        `UPDATE ${REPORT_SCHEDULES_TABLE}
            SET running_count = COALESCE(running_count, 0) + 1,
                next_run = ?,
                updated_at = ?
          WHERE id = ?`,
        nextRun.toISOString(),
        new Date().toISOString(),
        schedule.id,
      );
      this.emit('schedule:triggered', schedule);
    } catch (error) {
      await this.db.query(
        `UPDATE ${REPORT_SCHEDULES_TABLE}
            SET last_error = ?,
                updated_at = ?
          WHERE id = ?`,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
        schedule.id,
      );
      this.emit('schedule:error', schedule, error as Error);
    }
  }
}

interface ReportScheduleRow {
  id: unknown;
  tenant_id: unknown;
  report_class: unknown;
  cron: unknown;
  trigger: unknown;
  mode: unknown;
  queue: unknown;
  priority: unknown;
  timeout: unknown;
}

export function registerReportRefreshInterceptor(
  options: ReportRefreshInterceptorOptions,
): () => boolean {
  const name = options.name ?? 'smrt-reports-refresh';
  GlobalInterceptors.register({
    name,
    priority: -10,
    async afterSave(instance, context) {
      await triggerReportsForInstance(options, instance, context);
    },
    async afterDelete(instance, context) {
      await triggerReportsForInstance(options, instance, context);
    },
  });
  return () => GlobalInterceptors.unregister(name);
}

async function triggerReportsForInstance(
  options: ReportRefreshInterceptorOptions,
  instance: SmrtObject,
  context: InterceptorContext,
): Promise<void> {
  for (const reportCtor of options.reports) {
    const definition = await buildReportDefinition(reportCtor);
    if (definition.refresh?.manual) continue;
    if (!sourceMatches(definition, instance, context)) continue;

    const mode = definition.refresh?.mode ?? 'incremental';
    const tenantId = tenantIdFromInstance(instance);
    const changedRows = [changedRowSnapshot(instance)];
    if (options.enqueue === false) {
      await refreshReport(reportCtor, {
        db: options.db,
        mode,
        trigger: 'change',
        tenantId,
        changedRows,
      });
      continue;
    }

    await enqueueReportRefresh({
      db: options.db,
      reportClass: canonicalClassName(reportCtor),
      mode,
      trigger: 'change',
      tenantId,
      queue: options.queue,
      priority: options.priority,
      timeout: options.timeout,
      tenantJobCap: options.tenantJobCap,
      changedRows,
      integritySigner: options.integritySigner,
    });
  }
}

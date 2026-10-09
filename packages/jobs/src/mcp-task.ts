import type { DatabaseInterface } from '@happyvertical/sql';
import { createId } from '@happyvertical/utils';
import { type SmrtJob, SmrtJobCollection } from './smrt-job.js';
import { terminalSnapshot, transitionTerminalJob } from './terminal-outcome.js';

/** The MCP Tasks extension identifier implemented by this durable adapter. */
export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** MCP task states defined by the Tasks extension. */
export type McpTaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Durable shape returned by `tasks/get` after the transport adds `resultType`. */
export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs?: number;
  statusMessage?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Immutable reference to an owning workflow record, never an approval. */
export interface McpTaskContinuation {
  recordId: string;
  revision: string;
  inputKey: string;
}

/** Live runner authority: implementations resolve current grants, never snapshots. */
export interface McpTaskAuthority {
  continuation?: Readonly<McpTaskContinuation>;
  ownerId: string;
  tenantId: string | null;
  taskId: string;
  objectType: string;
  objectId: string;
  method: string;
}

/** Internal control flow after input is durably persisted and the worker released. */
export class McpTaskSuspendedError extends Error {}

/** Arguments passed through an MCP tool action into its backing job. */
export interface CreateMcpTaskInput {
  objectType: string;
  objectId: string;
  method: string;
  /** Exact positional custom-action invocation produced by the MCP generator. */
  invocationArgs: unknown[];
  tenantId?: string | null;
  continuation?: McpTaskContinuation;
  /** Optional agent constructor configuration retained by normal background jobs. */
  agentConfig?: Record<string, unknown>;
  timeout?: number;
  pollIntervalMs?: number;
  ttlMs?: number;
}

/** Internal persisted marker distinguishing task invocations from normal jobs. */
export interface McpTaskJobMarker {
  /** Set by the trusted app task store, never by tool arguments. */
  authorizationRequired?: boolean;
  continuation?: McpTaskContinuation;
  invocationArgs: unknown[];
  pollIntervalMs: number;
  ttlMs: number;
}

/** Serialize a completed task exactly as an MCP CallToolResult. */
export function createMcpTaskResult(result: unknown): Record<string, unknown> {
  // JSON.stringify(undefined) returns undefined rather than valid JSON. The
  // generated MCP result boundary represents non-JSON/void action results as
  // null, so preserve that contract in the durable task payload too.
  const publicResult = toPublicTaskData(result) ?? null;
  return {
    content: [{ type: 'text', text: JSON.stringify(publicResult) }],
    structuredContent: { data: publicResult },
  };
}

/** Thrown when a task doesn't belong to the current task-store principal. */
export class McpTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`MCP task not found: ${taskId}`);
    this.name = 'McpTaskNotFoundError';
  }
}

/** Cooperative cancellation observed by an operation awaiting task input. */
export class McpTaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`MCP task was cancelled: ${taskId}`);
    this.name = 'McpTaskCancelledError';
  }
}

/**
 * Durable adapter between the MCP Tasks extension and `_smrt_jobs`.
 *
 * A task is a projection of exactly one job row: `task_id` is a unique
 * correlation key on the row and cancellation changes that same row. This is
 * intentionally not a second task table, which prevents an orphaned queued
 * job when a caller cancels an MCP task.
 */
export class McpTaskStore {
  private readonly ownerId: string | null;
  private readonly requireAuthorization: boolean;
  private readonly tenantId: string | null;

  private constructor(
    private readonly collection: SmrtJobCollection,
    options: {
      /** Require live worker authorization for every task from this store. */
      requireAuthorization?: boolean;
      ownerId?: string | null;
      tenantId?: string | null;
      pollIntervalMs?: number;
      ttlMs?: number;
    },
  ) {
    this.ownerId = options.ownerId ?? null;
    this.requireAuthorization = options.requireAuthorization ?? false;
    this.tenantId = options.tenantId ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.ttlMs = options.ttlMs ?? 86_400_000;
  }

  readonly pollIntervalMs: number;
  readonly ttlMs: number;

  static async create(
    db: DatabaseInterface,
    options: {
      /** Require live worker authorization for every task from this store. */
      requireAuthorization?: boolean;
      ownerId?: string | null;
      tenantId?: string | null;
      pollIntervalMs?: number;
      ttlMs?: number;
    } = {},
  ): Promise<McpTaskStore> {
    const collection = await SmrtJobCollection.create({ db });
    return new McpTaskStore(collection, options);
  }

  /** Create one pending job and return its immediately-pollable task projection. */
  async createTask(input: CreateMcpTaskInput): Promise<McpTask> {
    if ((input.tenantId ?? null) !== this.tenantId) {
      throw new Error('MCP task tenant does not match active tenant');
    }
    if (this.requireAuthorization && !this.ownerId)
      throw new Error('Authorized tasks require an owner');
    const continuation = input.continuation
      ? Object.freeze(validateContinuation(input.continuation))
      : undefined;
    if (continuation) {
      if (!this.ownerId)
        throw new Error('Durable continuation requires an owner');
    }
    const taskId = createId();
    const pollIntervalMs = input.pollIntervalMs ?? this.pollIntervalMs;
    const ttlMs = input.ttlMs ?? this.ttlMs;
    const marker: McpTaskJobMarker = {
      invocationArgs: input.invocationArgs,
      ...(this.requireAuthorization ? { authorizationRequired: true } : {}),
      ...(continuation ? { continuation } : {}),
      pollIntervalMs,
      ttlMs,
    };
    const args: Record<string, unknown> = {
      _mcpTask: marker,
      ...(input.agentConfig ? { _agentConfig: input.agentConfig } : {}),
    };

    const job = await this.collection.enqueueJob({
      tenantId: input.tenantId ?? null,
      queue: 'mcp-tasks',
      objectType: input.objectType,
      objectId: input.objectId,
      method: input.method,
      args,
      timeout: input.timeout,
      ...(continuation || this.requireAuthorization ? { maxAttempts: 1 } : {}),
      taskId,
      taskOwnerId: this.ownerId,
      taskInputRequests: null,
      taskInputResponses: null,
    });

    return taskFromJob(job, { pollIntervalMs, ttlMs });
  }

  /**
   * Read a waiting task's application input descriptor for an explicitly declared
   * workflow tool or authenticated form. This is not an MCP protocol extension.
   */
  async getContinuation(taskId: string): Promise<{
    binding: McpTaskContinuation;
    inputRequests: Record<string, unknown>;
  } | null> {
    const job = await this.findTaskJob(taskId);
    const binding = getMcpTaskMarker(job)?.continuation;
    if (!binding || job.status !== 'pending' || job.taskInputResponses !== null)
      return null;
    const inputRequests = asRecord(job.taskInputRequests);
    if (!Object.keys(inputRequests).length) return null;
    return { binding, inputRequests };
  }

  /** Get a task only when it belongs to this store's principal. */
  async getTask(taskId: string): Promise<McpTask> {
    const job = await this.findTaskJob(taskId);
    const marker = getMcpTaskMarker(job);
    return taskFromJob(
      job,
      marker ?? {
        pollIntervalMs: this.pollIntervalMs,
        ttlMs: this.ttlMs,
      },
    );
  }

  /**
   * Persist only values requested by an outstanding `requestInput()` call.
   * Unknown and already-consumed keys are intentionally ignored per SEP-2663.
   */
  async updateTask(
    taskId: string,
    inputResponses: Record<string, unknown>,
  ): Promise<void> {
    const job = await this.findTaskJob(taskId);
    const requested = asRecord(job.taskInputRequests);
    if (getMcpTaskMarker(job)?.continuation) {
      if (
        !Object.keys(requested).length ||
        !Object.keys(requested).every((key) =>
          Object.hasOwn(inputResponses, key),
        )
      )
        return;
      const selected = Object.fromEntries(
        Object.keys(requested).map((key) => [key, inputResponses[key]]),
      );
      await this.collection.query(
        `UPDATE _smrt_jobs SET task_input_responses = ?, updated_at = ?
          WHERE id = ? AND task_id = ? AND status = 'pending'
            AND task_input_responses IS NULL`,
        [
          encodeContinuationJson(selected),
          new Date().toISOString(),
          job.id,
          taskId,
        ],
        { allowRawOnTenantScoped: true },
      );
      return;
    }
    if (Object.keys(requested).length === 0) return;

    const current = asRecord(job.taskInputResponses);
    const accepted: Record<string, unknown> = { ...current };
    for (const key of Object.keys(requested)) {
      if (Object.hasOwn(inputResponses, key)) {
        accepted[key] = inputResponses[key];
      }
    }

    await this.collection.query(
      `UPDATE _smrt_jobs
          SET task_input_responses = ?, updated_at = ?
        WHERE id = ? AND task_id = ?`,
      [JSON.stringify(accepted), new Date().toISOString(), job.id, taskId],
      { allowRawOnTenantScoped: true },
    );
  }

  /**
   * Cooperatively cancel the backing job. A completion race cannot resurrect
   * it because TaskRunner terminal writes require `status = 'running'`.
   */
  async cancelTask(taskId: string): Promise<void> {
    const job = await this.findTaskJob(taskId);
    if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      return;
    }

    const snapshot = terminalSnapshot(job);
    if (!snapshot) throw new McpTaskNotFoundError(taskId);
    await transitionTerminalJob(this.collection.db, {
      job: snapshot,
      status: 'cancelled',
      completedAt: new Date(),
      expectedStatuses: ['pending', 'running'],
      expectedTaskId: taskId,
    });
  }

  private async findTaskJob(taskId: string): Promise<SmrtJob> {
    const ownerPredicate =
      this.ownerId === null ? 'task_owner_id IS NULL' : 'task_owner_id = ?';
    const params: unknown[] =
      this.ownerId === null ? [taskId] : [taskId, this.ownerId];
    const tenantPredicate =
      this.tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
    if (this.tenantId !== null) params.push(this.tenantId);
    const jobs = await this.collection.query(
      `SELECT * FROM _smrt_jobs WHERE task_id = ? AND ${ownerPredicate} AND ${tenantPredicate} LIMIT 1`,
      params,
      { allowRawOnTenantScoped: true },
    );
    const job = jobs[0];
    if (!job) throw new McpTaskNotFoundError(taskId);
    return job;
  }
}

/** Retrieve an internal task marker without exposing it to ordinary job callers. */
export function getMcpTaskMarker(
  job: Pick<SmrtJob, 'args'>,
): McpTaskJobMarker | null {
  const marker = asRecord(asRecord(job.args)._mcpTask);
  if (!Array.isArray(marker.invocationArgs)) return null;
  return {
    invocationArgs: marker.invocationArgs,
    ...(marker.authorizationRequired === true
      ? { authorizationRequired: true }
      : {}),
    ...(marker.continuation
      ? { continuation: validateContinuation(marker.continuation) }
      : {}),
    pollIntervalMs: asPositiveInt(marker.pollIntervalMs, 250),
    ttlMs: asPositiveInt(marker.ttlMs, 86_400_000),
  };
}

/**
 * Persist one immutable input round and release the worker. On replay the handler
 * starts again; work before this seam must be read-only or use owning runOnce /
 * action idempotency. An answer is input only, never domain approval.
 */
export async function requestMcpTaskContinuation(
  db: DatabaseInterface,
  job: Pick<SmrtJob, 'id' | 'taskId' | 'workerId' | 'args'>,
  binding: McpTaskContinuation,
  inputRequest: unknown,
): Promise<unknown> {
  validateContinuation(binding);
  const expected = getMcpTaskMarker(job)?.continuation;
  if (
    !expected ||
    expected.recordId !== binding.recordId ||
    expected.revision !== binding.revision ||
    expected.inputKey !== binding.inputKey
  ) {
    throw new Error('MCP continuation binding mismatch');
  }
  const found = await db.query(
    `SELECT task_input_responses FROM _smrt_jobs
      WHERE id = ? AND task_id = ? AND worker_id = ? AND status = 'running'`,
    job.id,
    job.taskId,
    job.workerId,
  );
  if (found.rows.length !== 1)
    throw new McpTaskCancelledError(job.taskId ?? '');
  const answers = asRecord(parseJson(found.rows[0].task_input_responses));
  if (Object.hasOwn(answers, binding.inputKey))
    return answers[binding.inputKey];
  const suspended = await db.query(
    `UPDATE _smrt_jobs SET status = 'pending', worker_id = NULL,
      worker_heartbeat = NULL, task_input_requests = ?, updated_at = ?
      WHERE id = ? AND task_id = ? AND worker_id = ? AND status = 'running'
      RETURNING id`,
    encodeContinuationJson({ [binding.inputKey]: inputRequest }),
    new Date().toISOString(),
    job.id,
    job.taskId,
    job.workerId,
  );
  if (suspended.rows.length !== 1)
    throw new McpTaskCancelledError(job.taskId ?? '');
  throw new McpTaskSuspendedError('MCP task awaits durable input');
}

function encodeContinuationJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (
        item === undefined ||
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        typeof item === 'bigint' ||
        (typeof item === 'number' && !Number.isFinite(item))
      ) {
        throw new Error('Invalid JSON');
      }
      return item;
    });
    if (!json || new TextEncoder().encode(json).byteLength > 65_536)
      throw new Error('Oversized JSON');
    return json;
  } catch {
    throw new Error('MCP continuation input must be JSON within 65536 bytes');
  }
}

function validateContinuation(value: unknown): McpTaskContinuation {
  const source = asRecord(value);
  const record: Record<string, unknown> = {
    recordId: source.recordId,
    revision: source.revision,
    inputKey: source.inputKey,
  };
  for (const key of ['recordId', 'revision', 'inputKey']) {
    if (
      typeof record[key] !== 'string' ||
      !record[key] ||
      record[key].length > 256
    ) {
      throw new Error('Invalid MCP continuation binding');
    }
  }
  return {
    recordId: record.recordId as string,
    revision: record.revision as string,
    inputKey: record.inputKey as string,
  };
}

/**
 * Make a task operation wait for user input. It is intentionally a method on
 * JobExecutionContext rather than an MCP transport concern, so generated
 * stdio and stateless HTTP share one durable input seam.
 */
export async function requestMcpTaskInput(
  db: DatabaseInterface,
  job: Pick<SmrtJob, 'id' | 'taskId' | 'workerId'>,
  inputRequests: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const jobId = job.id;
  const taskId = job.taskId;
  if (!jobId || !taskId || !job.workerId) {
    throw new Error(
      'Task input is only available while an MCP task job is running',
    );
  }
  if (Object.keys(inputRequests).length === 0) return {};

  const now = new Date().toISOString();
  await db.query(
    `UPDATE _smrt_jobs
        SET task_input_requests = ?, task_input_responses = NULL, updated_at = ?
      WHERE id = ? AND task_id = ? AND worker_id = ? AND status = 'running'`,
    JSON.stringify(inputRequests),
    now,
    jobId,
    taskId,
    job.workerId,
  );

  while (true) {
    const result = await db.query(
      `SELECT status, task_input_responses FROM _smrt_jobs WHERE id = ? AND task_id = ?`,
      jobId,
      taskId,
    );
    const row = result.rows[0] as
      | { status?: string; task_input_responses?: unknown }
      | undefined;
    if (!row || row.status === 'cancelled')
      throw new McpTaskCancelledError(taskId);
    if (row.status !== 'running')
      throw new Error(`MCP task is no longer running: ${taskId}`);

    const responses = asRecord(parseJson(row.task_input_responses));
    if (
      Object.keys(inputRequests).every((key) => Object.hasOwn(responses, key))
    ) {
      const selected = Object.fromEntries(
        Object.keys(inputRequests).map((key) => [key, responses[key]]),
      );
      await db.query(
        `UPDATE _smrt_jobs
            SET task_input_requests = NULL, updated_at = ?
          WHERE id = ? AND task_id = ? AND worker_id = ? AND status = 'running'`,
        new Date().toISOString(),
        jobId,
        taskId,
        job.workerId,
      );
      return selected;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Convert the job state into the flat task shape required by `tasks/get`. */
export function taskFromJob(
  job: SmrtJob,
  marker: Pick<McpTaskJobMarker, 'pollIntervalMs' | 'ttlMs'>,
): McpTask {
  const status = taskStatusFromJob(job);
  const createdAt = toIso(job.created_at) ?? new Date().toISOString();
  const lastUpdatedAt = toIso(job.updated_at) ?? createdAt;
  const task: McpTask = {
    taskId: job.taskId ?? '',
    status,
    createdAt,
    lastUpdatedAt,
    ttlMs: marker.ttlMs,
    pollIntervalMs: marker.pollIntervalMs,
  };
  if (status === 'input_required')
    task.statusMessage = 'Waiting for required input';
  if (status === 'cancelled') task.statusMessage = 'Task cancelled';
  if (status === 'failed') {
    task.statusMessage = job.lastError ?? 'Task failed';
    task.error = { code: -32603, message: task.statusMessage };
  }
  if (status === 'completed' && job.taskResult) task.result = job.taskResult;
  return task;
}

function taskStatusFromJob(job: SmrtJob): McpTaskStatus {
  if (job.status === 'completed') return 'completed';
  if (job.status === 'cancelled') return 'cancelled';
  if (job.status === 'failed') return 'failed';
  if (
    Object.keys(asRecord(job.taskInputRequests)).length > 0 &&
    !(getMcpTaskMarker(job)?.continuation && job.taskInputResponses !== null)
  )
    return 'input_required';
  return 'working';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return {};
  return value as Record<string, unknown>;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

/** Match generated MCP's sensitive-field-safe public serialization boundary. */
function toPublicTaskData(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const publicSource = value as {
    toPublicJSON?: (options?: Record<string, unknown>) => unknown;
  };
  if (typeof publicSource.toPublicJSON === 'function') {
    return publicSource.toPublicJSON({});
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((entry) => toPublicTaskData(entry, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = toPublicTaskData(nested, seen);
  }
  return out;
}

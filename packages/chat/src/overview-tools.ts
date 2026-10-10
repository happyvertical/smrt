/**
 * Assistant tools for customizable overview pages (#3727 phase 4): the
 * assistant adds and configures widgets ("add a chart of overdue invoices")
 * with structured operations, and the person can undo the change.
 *
 * The model only ever supplies data: a page id and a list of operations
 * (`add`, `configure`, `move`, `resize`, `remove`) over the page's closed
 * option vocabulary. It never names a query, a table or a tenant. Every
 * authority decision is the host's, made from the live {@link PrincipalRun}:
 *
 * - `open(run, pageId)` returns the overview for THIS principal (its
 *   definition, the principal's stored override, whether the principal may
 *   customize, and how to persist), or `null` when the page is not offered.
 * - The surface validates every batch with the overview model and
 *   `checkOverviewOverride` (smrt-svelte's `createOverviewAssistantSurface`
 *   is the implementation), so the assistant can only store an override the
 *   page's own save endpoint would accept. A batch is atomic.
 * - Undo is single-step and keyed by tenant, user and page: an undo token is
 *   only ever looked up under the principal that is calling, so one
 *   principal can never restore another's state.
 *
 * This package depends on no UI package, so the surface is typed
 * structurally.
 *
 * @module
 */

import type { AITool } from '@happyvertical/ai';
import {
  DataSurfaceDeniedError,
  type PrincipalRun,
  type PrincipalTool,
  type PrincipalToolContext,
} from '@happyvertical/smrt-agents';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  isSystemContext,
  isTenancyEnabled,
  withTenant,
} from '@happyvertical/smrt-tenancy';

/** Tool slug (permission/allow-list name) for describing an overview. */
export const OVERVIEW_DESCRIBE_TOOL_SLUG = 'overviews.describe';
/** Tool slug for applying a batch of operations. */
export const OVERVIEW_APPLY_TOOL_SLUG = 'overviews.apply';
/** Tool slug for undoing the last applied batch. */
export const OVERVIEW_UNDO_TOOL_SLUG = 'overviews.undo';

/** Provider function name for {@link OVERVIEW_DESCRIBE_TOOL_SLUG}. */
export const OVERVIEW_DESCRIBE_FUNCTION_NAME = 'overviews-describe';
/** Provider function name for {@link OVERVIEW_APPLY_TOOL_SLUG}. */
export const OVERVIEW_APPLY_FUNCTION_NAME = 'overviews-apply';
/** Provider function name for {@link OVERVIEW_UNDO_TOOL_SLUG}. */
export const OVERVIEW_UNDO_FUNCTION_NAME = 'overviews-undo';

/** Default cap on operations in one batch (matches smrt-svelte's). */
export const OVERVIEW_TOOL_MAX_OPERATIONS = 20;

const PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

/** A plan result, as the surface returns it. */
export type OverviewToolPlan =
  | {
      ok: true;
      override: unknown;
      document: unknown;
      results: readonly unknown[];
      unchanged?: boolean;
    }
  | { ok: false; issues: readonly unknown[] };

/** A save-style check of an override, as the surface returns it. */
export type OverviewToolCheck =
  | { ok: true; override: unknown }
  | { ok: false; issues: readonly unknown[] };

/**
 * One overview for one principal. smrt-svelte's
 * `createOverviewAssistantSurface` (on `./overview/server`) implements it.
 */
export interface OverviewToolSurface {
  readonly pageId: string;
  /** Whether this principal may customize the page (the role gate). */
  readonly canCustomize: boolean;
  /** Allowed widget types with their option fields, and the arrangement. */
  describe(): unknown;
  /** The canonical override in effect (`null` = defaults). */
  current(): unknown;
  /** Validate and plan a batch against {@link current}. Applies nothing. */
  plan(operations: unknown): OverviewToolPlan;
  /** Validate an override the way a save is validated. */
  check(override: unknown): OverviewToolCheck;
  /**
   * Persist a canonical override in the principal's tier, CONDITIONALLY: only
   * if the stored value is still the one this surface loaded (its revision).
   * A save that landed since the surface was opened must answer
   * `{ ok: false, reason: 'conflict' }`, never be overwritten. On success the
   * surface's `current()` and revision follow the written value.
   */
  persist(override: unknown): Promise<OverviewToolPersistResult>;
}

/**
 * Outcome of {@link OverviewToolSurface.persist}. Structurally the phase-3
 * store's save result (`OverviewSaveResult` of `@happyvertical/smrt-preferences`'
 * `createOverviewStore`).
 */
export type OverviewToolPersistResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'conflict' | 'not_allowed' | 'invalid';
      issues?: readonly unknown[];
    };

/** The application side: which overviews a principal may reach. */
export interface OverviewToolsHost {
  /**
   * The page for this principal, or `null` when it is unknown or not offered
   * to them. Build the surface from the principal's own stored override and
   * role; never from model input other than the page id. Scope every read
   * and the surface's `persist` by `run.context.tenantId` (with tenancy on,
   * the tools call `open` and every surface method inside that tenant's
   * context and refuse a run without one).
   */
  open(
    run: PrincipalRun,
    pageId: string,
  ): OverviewToolSurface | null | Promise<OverviewToolSurface | null>;
  /** Overview pages offered to this principal (for `describe` without a page). */
  pages?(
    run: PrincipalRun,
  ):
    | ReadonlyArray<{ id: string; title?: string }>
    | Promise<ReadonlyArray<{ id: string; title?: string }>>;
}

/** What Undo restores: the override before the last applied batch. */
export interface OverviewUndoEntry {
  token: string;
  before: unknown;
  after: unknown;
  createdAt: number;
}

/**
 * Where undo entries live, keyed by an opaque principal-and-page key the
 * tools compute. The default is in-process memory; a multi-replica host
 * passes a shared store (for example the assistant session context).
 */
export interface OverviewUndoStore {
  get(
    key: string,
  ): OverviewUndoEntry | undefined | Promise<OverviewUndoEntry | undefined>;
  set(key: string, entry: OverviewUndoEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** Agent-level audit record of an overview change. */
export interface OverviewToolAuditEntry {
  action: 'apply' | 'undo';
  userId: string;
  tenantId: string | null;
  pageId: string;
  operations?: number;
}

export interface OverviewToolsOptions {
  host: OverviewToolsHost;
  /**
   * Where undo entries live. It must outlive a request and a turn. Defaults
   * to {@link defaultOverviewUndoStore} (process-wide memory); pass a shared
   * store when several replicas serve one assistant.
   */
  undoStore?: OverviewUndoStore;
  audit?: (entry: OverviewToolAuditEntry) => void | Promise<void>;
  /** Batch cap (default 20); keep it equal to the surface's. */
  maxOperations?: number;
  /** Token source (tests). Defaults to `crypto.randomUUID`. */
  createToken?: () => string;
  /**
   * Receives best-effort failures after a change was stored (undo entry,
   * audit). Defaults to `console.warn`; route it to the host's logger.
   */
  onError?: (error: unknown, context: string) => void;
}

/**
 * A tool refusal the loop classifies by `status`: 422/404/409 are repairable
 * (`invalid_request`, the model sees `publicMessage`), 403 is `not_permitted`.
 */
export class OverviewToolError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;
  readonly issues: readonly unknown[];

  constructor(
    status: number,
    code: string,
    message: string,
    issues: readonly unknown[] = [],
  ) {
    super(message);
    this.name = 'OverviewToolError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    this.issues = issues;
  }
}

/**
 * In-process undo store: single entry per key, expiring after `ttlMs`
 * (default 30 minutes), at most `maxEntries` keys (oldest dropped).
 */
export function createMemoryOverviewUndoStore(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): OverviewUndoStore {
  const ttl = options.ttlMs ?? 30 * 60_000;
  const max = options.maxEntries ?? 1000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, OverviewUndoEntry>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry && now() - entry.createdAt > ttl) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

let processUndoStore: OverviewUndoStore | undefined;

/**
 * The process-wide in-memory undo store `createOverviewTools` uses when no
 * `undoStore` is passed. It outlives every tool set, so tools built per turn
 * (`extraTools: (context) => createOverviewTools(...)`) can undo a batch an
 * earlier turn applied. Keys carry tenant, user and page, so sharing it is
 * safe; it is per process, so a multi-replica host passes a shared store.
 */
export function defaultOverviewUndoStore(): OverviewUndoStore {
  processUndoStore ??= createMemoryOverviewUndoStore();
  return processUndoStore;
}

function principalFromRun(run: PrincipalRun): {
  userId: string;
  tenantId: string | null;
} {
  const userId = run.context.userId;
  if (!userId) throw new DataSurfaceDeniedError();
  return { userId, tenantId: run.context.tenantId };
}

/**
 * Run under the AUTHENTICATED principal's tenant (the runtime-report tools'
 * guard): with tenancy on, a run without a tenant is refused, the principal's
 * tenant is entered when no tenant context is active, and an ambient tenant
 * that disagrees with the principal is refused (unless the caller is
 * deliberately in a system-context or super-admin path). `host.open` and
 * every surface call, including `persist`, run inside it.
 */
async function withPrincipalTenant<T>(
  run: PrincipalRun,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isTenancyEnabled()) return fn();
  const tenantId = run.context.tenantId;
  if (!tenantId) {
    throw new OverviewToolError(
      403,
      'tenant_required',
      'A tenant is required to use overview tools.',
    );
  }
  const active = getCurrentTenant();
  if (active === undefined) return withTenant({ tenantId }, fn);
  if (
    active.tenantId !== tenantId &&
    !isSystemContext() &&
    !isSuperAdminBypass()
  ) {
    throw new DataSurfaceDeniedError();
  }
  return fn();
}

/** The allow-list gate, the principal check and the tenant guard, in order. */
function guarded(
  slug: string,
  body: (context: PrincipalToolContext) => Promise<unknown>,
): PrincipalTool['execute'] {
  return async (context) => {
    context.run.assertToolAllowed(slug);
    principalFromRun(context.run);
    return withPrincipalTenant(context.run, () => body(context));
  };
}

function aiTool(
  slug: string,
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: PrincipalTool['execute'],
): PrincipalTool {
  return {
    slug,
    aiTool: {
      type: 'function',
      function: { name, description, parameters },
    } satisfies AITool,
    execute,
  };
}

/** A refused conditional write, as a tool error. */
function persistFailure(
  result: Exclude<OverviewToolPersistResult, { ok: true }>,
  conflict: { code: string; message: string },
): OverviewToolError {
  if (result.reason === 'conflict') {
    return new OverviewToolError(409, conflict.code, conflict.message);
  }
  if (result.reason === 'not_allowed') {
    return new OverviewToolError(
      403,
      'not_allowed',
      'You may not change this overview.',
    );
  }
  const issues = result.issues ?? [];
  return new OverviewToolError(
    422,
    'invalid_operations',
    `The overview rejected the change and nothing changed. ${formatOverviewIssues(issues)}`,
    issues,
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** "#2 add: widget type "map" is not registered; ..." for the model. */
export function formatOverviewIssues(issues: readonly unknown[]): string {
  return issues
    .slice(0, 10)
    .map((issue) => {
      const record =
        issue && typeof issue === 'object'
          ? (issue as Record<string, unknown>)
          : {};
      const at =
        typeof record.index === 'number' ? `#${record.index + 1}` : 'batch';
      const op = typeof record.op === 'string' ? ` ${record.op}` : '';
      const message =
        typeof record.message === 'string'
          ? record.message
          : typeof record.code === 'string'
            ? record.code
            : 'invalid';
      return `${at}${op}: ${message}`;
    })
    .join('; ');
}

const OPERATION_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  required: ['op'],
  additionalProperties: false,
  properties: {
    op: {
      type: 'string',
      enum: ['add', 'configure', 'move', 'resize', 'remove'],
    },
    type: {
      type: 'string',
      description: 'add: a widget type overviews-describe lists.',
    },
    id: {
      type: 'string',
      description: 'configure/move/resize/remove: an existing widget id.',
    },
    span: {
      type: 'integer',
      minimum: 1,
      maximum: 4,
      description: "add/resize: columns, within the type's span range.",
    },
    index: {
      type: 'integer',
      minimum: 0,
      description: 'add/move: zero-based position.',
    },
    options: {
      type: 'object',
      description:
        'add: the options; configure: keys to change (null resets a key). Only the option fields overviews-describe lists, with their allowed values.',
      additionalProperties: {
        type: ['string', 'number', 'boolean', 'null'],
      },
    },
  },
};

/**
 * Build the overview assistant tools. Offer them through `extraTools`; each
 * is gated by the same fail-closed `allowedTools` offer and execution gates
 * as every other principal tool.
 *
 * @param options - The host adapter, undo store, audit sink and batch cap.
 * @returns The `describe`, `apply` and `undo` principal tools.
 */
export function createOverviewTools(
  options: OverviewToolsOptions,
): PrincipalTool[] {
  const { host } = options;
  const undoStore = options.undoStore ?? defaultOverviewUndoStore();
  const maxOperations = options.maxOperations ?? OVERVIEW_TOOL_MAX_OPERATIONS;
  const createToken = options.createToken ?? (() => crypto.randomUUID());
  const onError =
    options.onError ??
    ((error: unknown, context: string) => {
      // biome-ignore lint/suspicious/noConsole: server-side default; hosts pass `onError` to route it to their logger
      console.warn(`[smrt-chat] ${context}`, error);
    });

  const undoKey = (run: PrincipalRun, pageId: string): string => {
    const { userId, tenantId } = principalFromRun(run);
    return JSON.stringify([tenantId, userId, pageId]);
  };

  const pageArg = (value: unknown): string => {
    if (typeof value !== 'string' || !PAGE_ID_PATTERN.test(value)) {
      throw new OverviewToolError(
        422,
        'invalid_page',
        'page must be an overview page id from overviews-describe',
      );
    }
    return value;
  };

  const open = async (
    run: PrincipalRun,
    pageId: string,
  ): Promise<OverviewToolSurface> => {
    const surface = await host.open(run, pageId);
    // Unknown, and not offered to this principal, answer the same.
    if (!surface || surface.pageId !== pageId) {
      throw new OverviewToolError(
        404,
        'unknown_page',
        `no overview page "${pageId}" is available`,
      );
    }
    return surface;
  };

  const requireCustomize = (surface: OverviewToolSurface): void => {
    if (!surface.canCustomize) {
      throw new OverviewToolError(
        403,
        'not_allowed',
        'You may not change this overview.',
      );
    }
  };

  /**
   * Best effort: by the time it runs the change is stored, and reporting the
   * tool as failed would make the model retry an applied batch.
   */
  const audit = async (
    run: PrincipalRun,
    entry: Omit<OverviewToolAuditEntry, 'userId' | 'tenantId'>,
  ): Promise<void> => {
    try {
      await options.audit?.({ ...entry, ...principalFromRun(run) });
    } catch (error) {
      onError(error, `overview tool audit failed (${entry.action})`);
    }
  };

  const describe = aiTool(
    OVERVIEW_DESCRIBE_TOOL_SLUG,
    OVERVIEW_DESCRIBE_FUNCTION_NAME,
    'Describe an overview page: the widget types it allows (with their option fields, allowed values and span range) and the widgets it shows now, in order, plus whether you may change it. Without a page, lists the overview pages available. Call before changing an overview; never invent types, option keys or models.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        page: { type: 'string', description: 'Overview page id.' },
      },
    },
    guarded(OVERVIEW_DESCRIBE_TOOL_SLUG, async ({ run, args }) => {
      if (args.page === undefined) {
        return { pages: host.pages ? await host.pages(run) : [] };
      }
      const surface = await open(run, pageArg(args.page));
      return { page: surface.pageId, overview: surface.describe() };
    }),
  );

  const apply = aiTool(
    OVERVIEW_APPLY_TOOL_SLUG,
    OVERVIEW_APPLY_FUNCTION_NAME,
    'Change an overview page with a batch of structured operations: add {type, span?, options, index?}, configure {id, options}, move {id, index}, resize {id, span}, remove {id}. The batch is all-or-nothing: if any operation is invalid nothing changes and the issues are returned to fix. Returns an undoToken; the person can undo the batch.',
    {
      type: 'object',
      required: ['page', 'operations'],
      additionalProperties: false,
      properties: {
        page: { type: 'string', description: 'Overview page id.' },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: maxOperations,
          items: OPERATION_PARAMETERS,
        },
      },
    },
    guarded(OVERVIEW_APPLY_TOOL_SLUG, async ({ run, args }) => {
      const pageId = pageArg(args.page);
      const operations = args.operations;
      if (
        !Array.isArray(operations) ||
        operations.length === 0 ||
        operations.length > maxOperations
      ) {
        throw new OverviewToolError(
          422,
          'invalid_operations',
          `operations must be an array of 1 to ${maxOperations} operations`,
        );
      }
      const surface = await open(run, pageId);
      requireCustomize(surface);
      const before = surface.current();
      const plan = surface.plan(operations);
      if (!plan.ok) {
        throw new OverviewToolError(
          422,
          'invalid_operations',
          `The batch was rejected and nothing changed. ${formatOverviewIssues(plan.issues)}`,
          plan.issues,
        );
      }
      const changed = !(plan.unchanged ?? sameJson(plan.override, before));
      if (!changed) {
        return {
          page: pageId,
          changed: false,
          applied: plan.results,
          undoToken: null,
        };
      }
      const written = await surface.persist(plan.override);
      if (!written.ok) {
        throw persistFailure(written, {
          code: 'conflict',
          message:
            'The overview changed while the batch was being applied, so nothing changed. Call overviews-describe again and rebuild the batch.',
        });
      }
      // The batch is stored. From here nothing may report the call as failed:
      // the model would retry it and duplicate the change. The undo entry is
      // written after the write (not before it and deleted on failure) because
      // a lost entry only costs the Undo, while an entry for a write that did
      // not happen could later "undo" someone else's value.
      let token: string | null = createToken();
      try {
        await undoStore.set(undoKey(run, pageId), {
          token,
          before,
          after: plan.override,
          createdAt: Date.now(),
        });
      } catch (error) {
        onError(error, 'overview undo entry was not stored');
        token = null;
      }
      await audit(run, {
        action: 'apply',
        pageId,
        operations: operations.length,
      });
      return {
        page: pageId,
        changed: true,
        applied: plan.results,
        undoToken: token,
        ...(token === null
          ? {
              note: 'The change was applied but cannot be undone with overviews-undo. Do not apply it again.',
            }
          : {}),
        overview: surface.describe(),
      };
    }),
  );

  const undo = aiTool(
    OVERVIEW_UNDO_TOOL_SLUG,
    OVERVIEW_UNDO_FUNCTION_NAME,
    'Undo the last batch applied to an overview page (pass the undoToken overviews-apply returned). Single step: only the latest batch can be undone, and not once the page changed since.',
    {
      type: 'object',
      required: ['page', 'undoToken'],
      additionalProperties: false,
      properties: {
        page: { type: 'string', description: 'Overview page id.' },
        undoToken: { type: 'string' },
      },
    },
    guarded(OVERVIEW_UNDO_TOOL_SLUG, async ({ run, args }) => {
      const pageId = pageArg(args.page);
      // Looked up under the CALLING principal only: another principal's
      // token is simply not found.
      const key = undoKey(run, pageId);
      const entry = await undoStore.get(key);
      if (
        !entry ||
        typeof args.undoToken !== 'string' ||
        entry.token !== args.undoToken
      ) {
        throw new OverviewToolError(
          409,
          'nothing_to_undo',
          'There is no assistant change with that undoToken to undo on this page; only the latest batch can be undone.',
        );
      }
      const surface = await open(run, pageId);
      requireCustomize(surface);
      if (!sameJson(surface.current(), entry.after)) {
        await undoStore.delete(key);
        throw new OverviewToolError(
          409,
          'changed_since',
          'The overview changed after that batch, so it was not undone.',
        );
      }
      const checked = surface.check(entry.before);
      if (!checked.ok) {
        await undoStore.delete(key);
        throw new OverviewToolError(
          409,
          'cannot_restore',
          `The earlier arrangement is no longer valid on this page. ${formatOverviewIssues(checked.issues)}`,
          checked.issues,
        );
      }
      const written = await surface.persist(checked.override);
      if (!written.ok) {
        // Keep the entry: only a successful conditional restore consumes it.
        throw persistFailure(written, {
          code: 'changed_since',
          message:
            'The overview changed after that batch, so it was not undone.',
        });
      }
      try {
        await undoStore.delete(key);
      } catch (error) {
        // A leftover entry no longer matches the stored value, so a second
        // undo answers changed_since; the restore itself succeeded.
        onError(error, 'overview undo entry was not removed');
      }
      await audit(run, { action: 'undo', pageId });
      return { page: pageId, undone: true, overview: surface.describe() };
    }),
  );

  return [describe, apply, undo];
}

/**
 * `mountListDataSurface` (#2906) — a one-liner to register an existing,
 * hand-rolled list component as a mounted {@link DataSurfaceDescriptor}
 * without adopting the `DataTable` component.
 *
 * `registerContentListDataSurface` in `@happyvertical/smrt-content/svelte`
 * proves the pattern: mirror a headless `DataTableController` into the
 * registry, translate visible commands back into controller dispatches, and
 * bump a monotonic revision whenever the controller or app-owned context
 * state changes. That logic is entangled with ContentList's view-mode
 * concept and `packages/content` has no dependency on this package, so this
 * module is a same-behavior PORT of that translation/registration logic —
 * not a shared import — generalized off the view-mode concept so any custom
 * list markup can register in one call instead of hand-mirroring the
 * registry contract (the exact duplication that motivated this issue: an
 * application page manually driving a headless `DataTableController` and
 * calling `registry.register` itself). The two copies must be kept in sync
 * by hand until they are unified behind a shared implementation in
 * `@happyvertical/smrt-ui/data` (both packages already depend on it) —
 * tracked as a follow-up (#2917). They are NOT currently identical: this
 * copy denies a controlled controller's table command that fails to settle
 * (see `applyControlledState` below) and calls `registry.register` before
 * subscribing to the controller to avoid leaking a subscription on a
 * throwing register; `registerContentListDataSurface` predates both fixes.
 * #2917 should adopt them rather than treat this copy as the odd one out.
 *
 * Call during component initialization (top level of `<script>`, or inside
 * an `$effect`); `destroy()` unregisters and unsubscribes, so tearing it down
 * on unmount is the caller's responsibility, exactly like
 * `registerContentListDataSurface`. Nothing here touches `window` or
 * `document` at module scope, so it is safe under `ssr = false` SPAs and
 * during SSR (the registry itself is a plain in-memory object).
 */

import type {
  DataSurfaceDescriptor,
  DataSurfaceJsonObject,
  DataSurfaceJsonValue,
  DataSurfaceRegistry,
  DataSurfaceSelectionReference,
  DataSurfaceVisibleCommand,
  DataTableCommand,
  DataTableControlledStateApplier,
  DataTableController,
  DataTableSelection,
} from '@happyvertical/smrt-ui/data';
import {
  DATA_TABLE_SURFACE_CONTROL_IDS,
  dataTableCommandFromDataSurfaceCommand,
  dataTableRowIdKey,
} from '@happyvertical/smrt-ui/data';

/**
 * Arbitrary, JSON-safe application state folded into every snapshot.
 *
 * `table` is reserved: the mounted controller's own snapshot is always
 * published under that key, so a context carrying it is rejected at mount
 * and on every `update()` rather than silently discarded. The registry's own
 * boundary-safe check further rejects transport-reserved keys such as
 * `token`, `where`, or `tenantId` — see `boundarySafeObject` in
 * `@happyvertical/smrt-ui/data`.
 */
export type ListDataSurfaceContext = Readonly<
  Record<string, DataSurfaceJsonValue>
>;

/**
 * A {@link ListDataSurfaceContext} update: same shape, but a key may also be
 * `undefined` to delete it from the published state (see
 * {@link ListDataSurfaceHandle.update}). Kept distinct from
 * `ListDataSurfaceContext` itself so the initial `context` option — which
 * has no delete affordance — stays exactly JSON-safe.
 */
export type ListDataSurfaceContextPatch = Readonly<
  Record<string, DataSurfaceJsonValue | undefined>
>;

export interface ListDataSurfaceControlResult {
  ok: boolean;
}

export interface MountListDataSurfaceOptions {
  registry: DataSurfaceRegistry;
  descriptor: DataSurfaceDescriptor;
  /** The headless controller the page already mirrors search/filters/sort/page/selection from. */
  controller: DataTableController;
  /** App-owned state (freshness, fingerprints, …) folded into `state` alongside the table snapshot. */
  context?: ListDataSurfaceContext;
  /** Carries the mounted identity's monotonic revision across re-registration. */
  initialRevision?: number;
  onRevision?: (revision: number) => void;
  /**
   * App-owned constraints that must hold before a visible table command is
   * acknowledged. Returning false denies the command rather than publishing
   * a transient state a later effect would correct.
   */
  acceptsTableCommand?: (command: DataTableCommand) => boolean;
  /**
   * REQUIRED when `controller` is controlled (`controller.isControlled()`):
   * a controlled controller's `dispatch()` only proposes state via its
   * `onStateChange` callback — it never applies it or notifies subscribers,
   * so without this the registry would acknowledge `ok: true` while nothing
   * actually changed. Mirrors `DataTable`'s own controlled-table contract
   * (`DataTableDataSurfaceOptions.applyControlledState`): settle the
   * candidate state (typically by awaiting whatever the page's
   * `onStateChange` triggered) and return the state that was actually
   * applied, or `undefined` to deny. The command is denied whenever the
   * controller's post-settle state does not match what was applied.
   */
  applyControlledState?: DataTableControlledStateApplier;
  /** Non-table visible commands (`refresh`/`retry`/`focus`/`reveal`/`highlight`) the page implements. */
  refresh?: () => boolean | Promise<boolean>;
  retry?: () => boolean | Promise<boolean>;
  focus?: () => void;
  reveal?: () => void;
  highlight?: () => void;
  /**
   * Escape hatch for custom controls beyond the fixed set above — a page can
   * expose any additional `controlId` its markup understands. Only invoked
   * when the command's `controlId` is not one of the fixed controls (a fixed
   * control with no matching callback is denied directly, never forwarded
   * here). Returning `false`/`{ ok: false }` denies the command; returning
   * `true`, `{ ok: true }`, or nothing (`void`) is treated as success. A
   * thrown error propagates out of `execute` and the registry reports it as
   * `execution_failed` — it is never silently treated as success.
   */
  onControl?: (
    controlId: string,
    payload: DataSurfaceJsonValue | undefined,
  ) =>
    | boolean
    | void
    | ListDataSurfaceControlResult
    | Promise<boolean | void | ListDataSurfaceControlResult>;
}

export interface ListDataSurfaceHandle {
  /**
   * Merge new app-owned context state over what is already published,
   * bumping the revision if the result changed. Keys `next` does not
   * mention are retained; pass a key explicitly as `undefined` to drop it.
   */
  update(context: ListDataSurfaceContextPatch): void;
  /** Unsubscribe from the controller and unregister from the registry. */
  destroy(): void;
}

const revisionsByRegistry = new WeakMap<
  DataSurfaceRegistry,
  Map<string, number>
>();

function identityKey(descriptor: DataSurfaceDescriptor): string {
  const { identity } = descriptor;
  return JSON.stringify([
    identity.kind,
    identity.surfaceId,
    identity.subject?.type,
    identity.subject?.id,
  ]);
}

function selectionReference(
  selection: DataTableSelection,
): DataSurfaceSelectionReference | null {
  if (selection.scope === 'page') return { scope: 'current-page' };
  if (selection.scope === 'allMatching') {
    return {
      scope: 'all-matching',
      queryFingerprint: selection.queryFingerprint,
    };
  }
  return selection.rowIds.length > 0
    ? { scope: 'explicit-ids', rowIds: selection.rowIds }
    : null;
}

const RESERVED_CONTEXT_KEYS = ['table'] as const;

/**
 * A command declaring a `controlId` from the canonical
 * `DATA_TABLE_SURFACE_CONTROL_IDS` (`@happyvertical/smrt-ui/data`) that still
 * fails to translate (an unparseable payload — e.g. `set-filters` with a
 * non-array `filters`) must be denied directly, never forwarded to
 * `onControl`: the descriptor and `acceptsTableCommand` gate never ran for
 * it, so treating it as a generic custom control would let an `onControl`
 * catch-all silently acknowledge a table mutation that was never applied.
 * Sourced from the same upstream enumeration `dataTableCommandFromDataSurfaceCommand`
 * is derived from — never a local copy of the id list — so an upstream
 * addition to that switch is covered here automatically.
 */
const TABLE_CONTROL_IDS: ReadonlySet<string> = new Set(
  DATA_TABLE_SURFACE_CONTROL_IDS,
);

function assertNoReservedContextKeys(context: DataSurfaceJsonObject): void {
  for (const key of RESERVED_CONTEXT_KEYS) {
    if (key in context) {
      throw new TypeError(
        `ListDataSurfaceContext must not use the reserved key "${key}" — the mounted controller's own snapshot is always published under it.`,
      );
    }
  }
}

function allowsFilterOperator(
  column: DataSurfaceDescriptor['columns'][number] | undefined,
  operator: string,
): boolean {
  if (!column) return false;
  const canonical = column.operators?.filter;
  const alias = column.filterOperators;
  if (canonical && alias)
    return canonical.includes(operator) && alias.includes(operator);
  return canonical?.includes(operator) ?? alias?.includes(operator) ?? false;
}

function commandAllowed(
  command: DataTableCommand,
  descriptor: DataSurfaceDescriptor,
  controller: DataTableController,
): boolean {
  const readable = new Set(
    descriptor.columns
      .filter((column) => column.capabilities.includes('read'))
      .map((column) => column.id),
  );
  const filterable = new Set(descriptor.query.filterableColumnIds ?? []);
  const sortable = new Set(descriptor.query.sortableColumnIds ?? []);
  switch (command.type) {
    case 'setFilters':
      return command.filters.every((filter) => {
        const column = descriptor.columns.find(
          (candidate) => candidate.id === filter.columnId,
        );
        return (
          filterable.has(filter.columnId) &&
          allowsFilterOperator(column, filter.operator)
        );
      });
    case 'setSorting':
      return command.sorting.every((sort) => sortable.has(sort.columnId));
    case 'toggleSorting':
      return sortable.has(command.columnId);
    case 'setSelectedRows':
      return command.rowIds.length <= descriptor.limits.maxSelectionSize;
    case 'toggleRowSelection': {
      const selection = controller.snapshot().state.selection;
      if (selection.scope === 'allMatching') return false;
      const selected = selection.rowIds.some(
        (rowId) =>
          dataTableRowIdKey(rowId) === dataTableRowIdKey(command.rowId),
      );
      return (
        selected || selection.rowIds.length < descriptor.limits.maxSelectionSize
      );
    }
    case 'setPageSize':
      return (
        command.pageSize === null ||
        (Number.isSafeInteger(command.pageSize) && command.pageSize > 0)
      );
    case 'setColumnOrder':
      return command.columnIds.every((columnId) => readable.has(columnId));
    case 'setColumnVisibility':
      return command.columns.every((column) => readable.has(column.columnId));
    default:
      return true;
  }
}

/** `undefined` (a `void` return) means the handler ran and succeeded. */
function normalizeControlResult(
  result: boolean | void | ListDataSurfaceControlResult,
): { ok: boolean } {
  if (result === undefined) return { ok: true };
  if (typeof result === 'boolean') return { ok: result };
  return { ok: result.ok };
}

/**
 * Register an existing, headless-controller-backed list as a mounted
 * `DataSurfaceDescriptor`. Mirrors `registerContentListDataSurface`'s
 * contract (stable identity independent of any view-mode churn, monotonic
 * per-identity revision, visible-command translation) without requiring the
 * ContentList view-mode concept, so any custom list can adopt it directly.
 */
export function mountListDataSurface(
  options: MountListDataSurfaceOptions,
): ListDataSurfaceHandle {
  let revisions = revisionsByRegistry.get(options.registry);
  if (!revisions) {
    revisions = new Map();
    revisionsByRegistry.set(options.registry, revisions);
  }
  const key = identityKey(options.descriptor);
  const previousRevision = revisions.get(key);
  let revision = Math.max(
    options.initialRevision ?? 0,
    previousRevision === undefined ? 0 : previousRevision + 1,
  );
  // Do NOT commit `revision` to the shared per-identity map, or subscribe to
  // the controller, until `registry.register` below succeeds. Both a bad
  // descriptor (duplicate identity, unknown column/control ids, …) and a
  // reserved context key throw synchronously; committing shared state first
  // would leave an orphaned controller subscriber writing a phantom revision
  // counter for an identity this call never actually owns.
  let context: DataSurfaceJsonObject = { ...(options.context ?? {}) };
  assertNoReservedContextKeys(context);
  let contextSignature = JSON.stringify(context);
  const advanceRevision = () => {
    revision += 1;
    revisions.set(key, revision);
    options.onRevision?.(revision);
  };
  const updateContext = (next: ListDataSurfaceContextPatch) => {
    // Genuinely "fold in": keys already published that `next` does not
    // mention are retained, matching this function's own documented
    // contract. A caller that wants a key gone passes it explicitly as
    // `undefined`; the registry rejects a literal `undefined` value (it is
    // not JSON-safe), so that case deletes the key outright instead.
    const draft: Record<string, DataSurfaceJsonValue | undefined> = {
      ...context,
      ...next,
    };
    for (const patchKey of Object.keys(next)) {
      if (next[patchKey] === undefined) delete draft[patchKey];
    }
    const merged = draft as DataSurfaceJsonObject;
    assertNoReservedContextKeys(merged);
    // `merged` may still carry a transport-reserved key (`tenantId`, `token`,
    // `where`, …) that only the registry's own boundary-safety check knows
    // about (`FORBIDDEN_BOUNDARY_KEYS` in `@happyvertical/smrt-ui/data`,
    // in-repo upstream — no local copy of that list here). Validate eagerly
    // by forcing the same read `registry.register` already performed at
    // mount, so a bad key throws synchronously at THIS call site instead of
    // being committed and only failing later on an unrelated `inspect()`/
    // `execute()` call against the now-poisoned surface. Roll back on
    // failure so the surface is left exactly as it was.
    const previousContext = context;
    context = merged;
    try {
      options.registry.inspect(options.descriptor.identity);
    } catch (error) {
      context = previousContext;
      throw error;
    }
    const signature = JSON.stringify(merged);
    if (signature !== contextSignature) {
      advanceRevision();
      contextSignature = signature;
    }
  };
  const unregister = options.registry.register({
    descriptor: options.descriptor,
    getSnapshot: () => {
      const table = options.controller.snapshot();
      return {
        revision,
        state: {
          ...context,
          table: table as unknown as DataSurfaceJsonValue,
        },
        selection: selectionReference(table.state.selection),
      };
    },
    execute: async (command: DataSurfaceVisibleCommand) => {
      const tableCommand = dataTableCommandFromDataSurfaceCommand(command);
      if (tableCommand) {
        if (
          !commandAllowed(
            tableCommand,
            options.descriptor,
            options.controller,
          ) ||
          options.acceptsTableCommand?.(tableCommand) === false
        )
          return { ok: false };
        const transition = options.controller.dispatch(tableCommand);
        if (options.controller.isControlled() && transition.changed) {
          // A controlled controller's dispatch() only proposed state via
          // onStateChange — it never applied it. Settle it (or deny) exactly
          // like DataTable's own controlled-table contract.
          const settled = await options.applyControlledState?.(
            transition.next.state,
            tableCommand,
          );
          if (settled) options.controller.replaceState(settled);
          if (
            JSON.stringify(options.controller.getState()) !==
            JSON.stringify(transition.next.state)
          ) {
            return { ok: false };
          }
        }
        return;
      }
      switch (command.controlId) {
        case 'refresh':
          if (!options.refresh) return { ok: false };
          if ((await options.refresh()) === false) return { ok: false };
          return;
        case 'retry':
          if (!options.retry) return { ok: false };
          if ((await options.retry()) === false) return { ok: false };
          return;
        case 'focus':
          if (!options.focus) return { ok: false };
          options.focus();
          return;
        case 'reveal':
          if (!options.reveal) return { ok: false };
          options.reveal();
          return;
        case 'highlight':
          if (!options.highlight) return { ok: false };
          options.highlight();
          return;
        default: {
          // A declared table-control id that failed to translate (e.g. an
          // unparseable payload) must be denied directly — it never reached
          // `commandAllowed`/`acceptsTableCommand`, so treating it as a
          // generic custom control would let `onControl` silently
          // acknowledge a table mutation that was never applied.
          if (TABLE_CONTROL_IDS.has(command.controlId)) return { ok: false };
          if (!options.onControl) return { ok: false };
          const result = normalizeControlResult(
            await options.onControl(command.controlId, command.payload),
          );
          return result.ok ? undefined : { ok: false };
        }
      }
    },
  });
  // Registration succeeded — now, and only now, commit the shared per-identity
  // revision and subscribe to the controller (see the note above).
  revisions.set(key, revision);
  const unsubscribe = options.controller.subscribe((transition) => {
    if (transition.changed) advanceRevision();
  });
  options.onRevision?.(revision);
  return {
    update: updateContext,
    destroy() {
      unsubscribe();
      unregister();
    },
  };
}

/**
 * `mountListDataSurface` (#2906) — a one-liner to register an existing,
 * hand-rolled list component as a mounted {@link DataSurfaceDescriptor}
 * without adopting the `DataTable` component.
 *
 * `registerContentListDataSurface` in `@happyvertical/smrt-content/svelte`
 * proves the pattern: mirror a headless `DataTableController` into the
 * registry, translate visible commands back into controller dispatches, and
 * bump a monotonic revision whenever the controller or app-owned context
 * state changes. That logic is package-specific to ContentList's view-mode
 * concept. This helper extracts the reusable core so any custom list markup
 * — a page that already owns its own status/sort/page/selection state and
 * only wants the registry wiring — can register in one call instead of
 * hand-mirroring the registry contract (the exact duplication that motivated
 * this issue: an application page manually driving a headless
 * `DataTableController` and calling `registry.register` itself).
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
  DataTableController,
  DataTableSelection,
} from '@happyvertical/smrt-ui/data';
import {
  dataTableCommandFromDataSurfaceCommand,
  dataTableRowIdKey,
} from '@happyvertical/smrt-ui/data';

/** Arbitrary, JSON-safe application state folded into every snapshot. */
export type ListDataSurfaceContext = Readonly<
  Record<string, DataSurfaceJsonValue>
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
  /** Non-table visible commands (`refresh`/`retry`/`focus`/`reveal`/`highlight`) the page implements. */
  refresh?: () => boolean | Promise<boolean>;
  retry?: () => boolean | Promise<boolean>;
  focus?: () => void;
  reveal?: () => void;
  highlight?: () => void;
  /**
   * Escape hatch for custom controls beyond the fixed set above — a page can
   * expose any additional `controlId` its markup understands. Returning
   * `false`/`{ ok: false }` denies the command; anything else (including a
   * thrown error, which propagates) is treated as success.
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
  /** Fold in new app-owned context state, bumping the revision if it changed. */
  update(context: ListDataSurfaceContext): void;
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

function payloadObject(
  value: DataSurfaceJsonValue | undefined,
): Record<string, DataSurfaceJsonValue> | undefined {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? value
    : undefined;
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

function normalizeControlResult(
  result: boolean | void | ListDataSurfaceControlResult,
): { ok: boolean } | undefined {
  if (result === undefined) return undefined;
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
  revisions.set(key, revision);
  const advanceRevision = () => {
    revision += 1;
    revisions.set(key, revision);
    options.onRevision?.(revision);
  };
  let context: DataSurfaceJsonObject = { ...(options.context ?? {}) };
  let contextSignature = JSON.stringify(context);
  const updateContext = (next: ListDataSurfaceContext) => {
    const merged: DataSurfaceJsonObject = { ...next };
    const signature = JSON.stringify(merged);
    if (signature !== contextSignature) {
      advanceRevision();
      contextSignature = signature;
    }
    context = merged;
  };
  const unsubscribe = options.controller.subscribe((transition) => {
    if (transition.changed) advanceRevision();
  });
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
        options.controller.dispatch(tableCommand);
        return;
      }
      switch (command.controlId) {
        case 'refresh':
          if (!options.refresh) break;
          if ((await options.refresh()) === false) return { ok: false };
          return;
        case 'retry':
          if (!options.retry) break;
          if ((await options.retry()) === false) return { ok: false };
          return;
        case 'focus':
          if (!options.focus) break;
          options.focus();
          return;
        case 'reveal':
          if (!options.reveal) break;
          options.reveal();
          return;
        case 'highlight':
          if (!options.highlight) break;
          options.highlight();
          return;
        default:
          break;
      }
      if (options.onControl) {
        const result = normalizeControlResult(
          await options.onControl(
            command.controlId,
            payloadObject(command.payload) as DataSurfaceJsonValue | undefined,
          ),
        );
        if (result) return result.ok ? undefined : { ok: false };
      }
      return { ok: false };
    },
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

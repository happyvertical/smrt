/** ContentList-owned mounted data surface, shared by every presentation. */

import {
  type DataSurfaceDescriptor,
  type DataSurfaceJsonObject,
  type DataSurfaceJsonValue,
  type DataSurfaceRegistry,
  type DataSurfaceSelectionReference,
  type DataSurfaceVisibleCommand,
  type DataTableCommand,
  type DataTableController,
  type DataTableSelection,
  dataTableCommandFromDataSurfaceCommand,
} from '@happyvertical/smrt-ui/data';
import type { ContentListViewMode } from './content-list-controller.js';

export interface ContentListSurfaceFreshness {
  stale: boolean;
  refreshing: boolean;
  offline: boolean;
  lastUpdated: string | null;
  truncated: boolean;
  warnings: readonly string[];
}

export interface ContentListSurfaceContext {
  viewMode: ContentListViewMode;
  queryFingerprint: string | null;
  totalRows: number | null;
  freshness: ContentListSurfaceFreshness;
}

export interface ContentListSurfaceRegistrationOptions {
  registry: DataSurfaceRegistry;
  descriptor: DataSurfaceDescriptor;
  controller: DataTableController;
  context: ContentListSurfaceContext;
  /** Carries the mounted identity's monotonic revision across re-registration. */
  initialRevision?: number;
  onRevision?: (revision: number) => void;
  setViewMode(viewMode: ContentListViewMode): void;
  refresh?: () => boolean | Promise<boolean>;
  retry?: () => boolean | Promise<boolean>;
  focus?: () => void;
  reveal?: () => void;
  highlight?: () => void;
}

export interface ContentListSurfaceHandle {
  update(context: ContentListSurfaceContext): void;
  destroy(): void;
}

const VIEWS = new Set<ContentListViewMode>(['grid', 'detailed', 'compact']);

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

function contextState(
  context: ContentListSurfaceContext,
): DataSurfaceJsonObject {
  return {
    viewMode: context.viewMode,
    queryFingerprint: context.queryFingerprint,
    totalRows: context.totalRows,
    freshness: {
      stale: context.freshness.stale,
      refreshing: context.freshness.refreshing,
      offline: context.freshness.offline,
      lastUpdated: context.freshness.lastUpdated,
      truncated: context.freshness.truncated,
      warnings: [...context.freshness.warnings],
    },
  };
}

function payloadObject(
  value: DataSurfaceJsonValue | undefined,
): Record<string, DataSurfaceJsonValue> | undefined {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? value
    : undefined;
}

function commandAllowed(
  command: DataTableCommand,
  descriptor: DataSurfaceDescriptor,
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
      return command.filters.every((filter) => filterable.has(filter.columnId));
    case 'setSorting':
      return command.sorting.every((sort) => sortable.has(sort.columnId));
    case 'toggleSorting':
      return sortable.has(command.columnId);
    case 'setSelectedRows':
      return command.rowIds.length <= descriptor.limits.maxSelectionSize;
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

/** Register one stable ContentList identity independently of its view mode. */
export function registerContentListDataSurface(
  options: ContentListSurfaceRegistrationOptions,
): ContentListSurfaceHandle {
  let revision = options.initialRevision ?? 0;
  const advanceRevision = () => {
    revision += 1;
    options.onRevision?.(revision);
  };
  let context = options.context;
  let contextSignature = JSON.stringify(contextState(context));
  const updateContext = (next: ContentListSurfaceContext) => {
    const signature = JSON.stringify(contextState(next));
    if (signature !== contextSignature) {
      advanceRevision();
      contextSignature = signature;
    }
    context = next;
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
          ...contextState(context),
          table: table as unknown as DataSurfaceJsonValue,
        },
        selection: selectionReference(table.state.selection),
      };
    },
    execute: async (command: DataSurfaceVisibleCommand) => {
      const tableCommand = dataTableCommandFromDataSurfaceCommand(command);
      if (tableCommand) {
        if (!commandAllowed(tableCommand, options.descriptor))
          return { ok: false };
        options.controller.dispatch(tableCommand);
        return;
      }
      switch (command.controlId) {
        case 'set-view': {
          const view = payloadObject(command.payload)?.view;
          if (
            typeof view !== 'string' ||
            !VIEWS.has(view as ContentListViewMode)
          )
            return { ok: false };
          const viewMode = view as ContentListViewMode;
          updateContext({ ...context, viewMode });
          options.setViewMode(viewMode);
          return;
        }
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
        default:
          return { ok: false };
      }
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

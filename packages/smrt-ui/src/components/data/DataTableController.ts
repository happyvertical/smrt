/**
 * Headless, transport-neutral state for DataTable.
 *
 * The controller intentionally stores only view preferences. It never stores
 * rows, callbacks, query objects, principals, or persistence adapters.
 */

export type DataTableRowId = string | number;

/** A caller-owned binding for an all-matching server-side selection. */
export interface DataTableQueryRevision {
  queryFingerprint: string;
  queryRevision: string;
}

/**
 * Selection is deliberately a tagged union. `allMatching` never serializes
 * loaded IDs: the receiving action must verify its query binding before use.
 */
export type DataTableSelection =
  | { scope: 'page'; rowIds: DataTableRowId[] }
  | { scope: 'explicit'; rowIds: DataTableRowId[] }
  | ({ scope: 'allMatching'; expectedCount: number } & DataTableQueryRevision);

export type DataTableJsonPrimitive = string | number | boolean | null;
export type DataTableJsonValue =
  | DataTableJsonPrimitive
  | DataTableJsonValue[]
  | { [key: string]: DataTableJsonValue };

export type DataTableOperationMode = 'local' | 'manual';

/** Which layer owns each transformation. `manual` means the caller supplied it. */
export interface DataTableModes {
  filtering: DataTableOperationMode;
  sorting: DataTableOperationMode;
  pagination: DataTableOperationMode;
}

export interface DataTableSortRule {
  columnId: string;
  direction: 'asc' | 'desc';
}

export type DataTableFilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'in'
  | 'notIn'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isNull'
  | 'isNotNull';

/** A serializable, declarative filter. Filters are combined with AND semantics. */
export interface DataTableFilter {
  columnId: string;
  operator: DataTableFilterOperator;
  value?: DataTableJsonValue;
}

/** A column visibility entry. The array form keeps snapshots JSON-safe. */
export interface DataTableColumnVisibility {
  columnId: string;
  visible: boolean;
}

/** A persisted width in CSS pixels. Static column widths remain presentation defaults. */
export interface DataTableColumnWidth {
  columnId: string;
  width: number;
}

/** A persisted edge pin. Column order is retained within each pin partition. */
export interface DataTableColumnPinning {
  columnId: string;
  position: 'start' | 'end';
}

/**
 * The JSON-safe, persistable portion of a table view. Selection and expansion
 * are serialized as canonical arrays rather than Sets.
 */
export interface DataTableViewState {
  search: string;
  filters: DataTableFilter[];
  sorting: DataTableSortRule[];
  page: number;
  pageSize: number | null;
  columnOrder: string[];
  columnVisibility: DataTableColumnVisibility[];
  columnWidths: DataTableColumnWidth[];
  columnPinning: DataTableColumnPinning[];
  selection: DataTableSelection;
  /**
   * Legacy shorthand for row-ID selections. It is always derived from
   * `selection`, and is empty for `allMatching` selections.
   */
  selectedRowIds: DataTableRowId[];
  expandedRowIds: DataTableRowId[];
}

/**
 * Accepts version-1 and version-2 controlled state while the controller emits
 * normalized version-3 state with explicit selection and column layout.
 */
export type DataTableViewStateInput = Omit<
  DataTableViewState,
  'selection' | 'columnWidths' | 'columnPinning'
> & {
  selection?: DataTableSelection;
  /** Optional while restoring version-1 or version-2 state. */
  columnWidths?: DataTableColumnWidth[];
  /** Optional while restoring version-1 or version-2 state. */
  columnPinning?: DataTableColumnPinning[];
};

/** The stable envelope intended for URL and saved-view adapters. */
export interface DataTableSnapshot {
  version: 3;
  modes: DataTableModes;
  state: DataTableViewState;
}

/** Every mutable table interaction has a plain-data command representation. */
export type DataTableCommand =
  | { type: 'setSearch'; search: string }
  | { type: 'setFilters'; filters: DataTableFilter[] }
  | { type: 'setSorting'; sorting: DataTableSortRule[] }
  | { type: 'toggleSorting'; columnId: string; multi?: boolean }
  | { type: 'setPage'; page: number }
  | { type: 'setPageSize'; pageSize: number | null }
  | { type: 'setColumnOrder'; columnIds: string[] }
  | { type: 'setColumnVisibility'; columns: DataTableColumnVisibility[] }
  | { type: 'setColumnWidths'; columns: DataTableColumnWidth[] }
  | { type: 'setColumnWidth'; columnId: string; width: number | null }
  | { type: 'setColumnPinning'; columns: DataTableColumnPinning[] }
  | {
      type: 'setColumnPin';
      columnId: string;
      position: DataTableColumnPinning['position'] | null;
    }
  | { type: 'setSelection'; selection: DataTableSelection }
  | { type: 'setPageSelection'; rowIds: DataTableRowId[] }
  | ({
      type: 'selectAllMatching';
      expectedCount: number;
    } & DataTableQueryRevision)
  | { type: 'setSelectedRows'; rowIds: DataTableRowId[] }
  | { type: 'toggleRowSelection'; rowId: DataTableRowId }
  | { type: 'setExpandedRows'; rowIds: DataTableRowId[] }
  | { type: 'toggleRowExpansion'; rowId: DataTableRowId }
  | { type: 'reset' };

export interface DataTableTransition {
  command: DataTableCommand | null;
  previous: DataTableSnapshot;
  next: DataTableSnapshot;
  changed: boolean;
}

export interface DataTableControllerOptions {
  /** Used by uncontrolled controllers. */
  initialState?: Partial<DataTableViewState>;
  /** Makes transitions proposals until `replaceState` supplies the next value. */
  state?: DataTableViewStateInput;
  modes?: Partial<DataTableModes>;
  /** Optional known columns let the controller ignore stale saved-view fields. */
  columnIds?: readonly string[];
  /** Static schema constraints that saved or controlled state may not override. */
  hiddenColumnIds?: readonly string[];
  onStateChange?: (
    state: DataTableViewState,
    command: DataTableCommand,
  ) => void;
}

export type DataTableStateListener = (transition: DataTableTransition) => void;

const DEFAULT_MODES: DataTableModes = {
  filtering: 'local',
  sorting: 'local',
  pagination: 'local',
};

const DEFAULT_STATE: DataTableViewState = {
  search: '',
  filters: [],
  sorting: [],
  page: 1,
  pageSize: null,
  columnOrder: [],
  columnVisibility: [],
  columnWidths: [],
  columnPinning: [],
  selection: { scope: 'explicit', rowIds: [] },
  selectedRowIds: [],
  expandedRowIds: [],
};

const FILTER_OPERATORS = new Set<DataTableFilterOperator>([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'in',
  'notIn',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull',
]);

function assertColumnId(value: unknown, label = 'column id'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`DataTable ${label} must be a non-empty string`);
  }
  return value;
}

export function assertDataTableRowId(value: unknown): DataTableRowId {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value))
    return value === 0 ? 0 : value;
  throw new TypeError(
    'DataTable row ids must be non-empty strings or finite numbers',
  );
}

function assertPage(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new TypeError('DataTable page must be a positive integer');
  }
  return value;
}

function assertPageSize(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(
      'DataTable pageSize must be a positive integer or null',
    );
  }
  return value;
}

function canonicalJson(
  value: unknown,
  ancestors = new Set<object>(),
): DataTableJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        'DataTable values must not contain non-finite numbers',
      );
    }
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new TypeError('DataTable values must not be circular');
    ancestors.add(value);
    const result = value.map((entry) => canonicalJson(entry, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    if (ancestors.has(value))
      throw new TypeError('DataTable values must not be circular');
    ancestors.add(value);
    const result: { [key: string]: DataTableJsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalJson(
        (value as Record<string, unknown>)[key],
        ancestors,
      );
    }
    ancestors.delete(value);
    return result;
  }
  throw new TypeError('DataTable values must be JSON-safe plain data');
}

function jsonSignature(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

export function compareDataTableRowIds(
  left: DataTableRowId,
  right: DataTableRowId,
): number {
  if (typeof left !== typeof right) return typeof left === 'number' ? -1 : 1;
  if (typeof left === 'number' && typeof right === 'number')
    return left - right;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function dataTableRowIdKey(value: DataTableRowId): string {
  return `${typeof value}:${String(value)}`;
}

function normalizeRowIds(values: readonly DataTableRowId[]): DataTableRowId[] {
  const ids = new Map<string, DataTableRowId>();
  for (const value of values) {
    const id = assertDataTableRowId(value);
    ids.set(dataTableRowIdKey(id), id);
  }
  return [...ids.values()].sort(compareDataTableRowIds);
}

function assertQueryRevisionValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`DataTable ${label} must be a non-empty string`);
  }
  return value;
}

function normalizeQueryRevision(value: unknown): DataTableQueryRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('DataTable query binding must be a plain object');
  }
  const input = value as Record<string, unknown>;
  return {
    queryFingerprint: assertQueryRevisionValue(
      input.queryFingerprint,
      'query fingerprint',
    ),
    queryRevision: assertQueryRevisionValue(
      input.queryRevision,
      'query revision',
    ),
  };
}

function normalizeSelection(
  value: unknown,
  legacyRowIds: readonly DataTableRowId[],
): DataTableSelection {
  if (value === undefined) {
    return { scope: 'explicit', rowIds: normalizeRowIds(legacyRowIds) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('DataTable selection must be a plain object');
  }
  const input = value as Record<string, unknown>;
  if (input.scope === 'page' || input.scope === 'explicit') {
    if (!Array.isArray(input.rowIds)) {
      throw new TypeError(`DataTable ${input.scope} selection requires rowIds`);
    }
    return { scope: input.scope, rowIds: normalizeRowIds(input.rowIds) };
  }
  if (input.scope === 'allMatching') {
    if (Object.hasOwn(input, 'rowIds')) {
      throw new TypeError(
        'DataTable allMatching selection must not contain rowIds',
      );
    }
    if (
      typeof input.expectedCount !== 'number' ||
      !Number.isFinite(input.expectedCount) ||
      !Number.isInteger(input.expectedCount) ||
      input.expectedCount < 0
    ) {
      throw new TypeError(
        'DataTable allMatching expectedCount must be a non-negative integer',
      );
    }
    return {
      scope: 'allMatching',
      ...normalizeQueryRevision(input),
      expectedCount: input.expectedCount,
    };
  }
  throw new TypeError(
    'DataTable selection scope must be page, explicit, or allMatching',
  );
}

function selectedRowIdsFor(selection: DataTableSelection): DataTableRowId[] {
  return selection.scope === 'allMatching' ? [] : selection.rowIds;
}

function withSelection(
  state: DataTableViewState,
  selection: DataTableSelection,
): DataTableViewState {
  const normalized = normalizeSelection(selection, []);
  return {
    ...state,
    selection: normalized,
    selectedRowIds: selectedRowIdsFor(normalized),
  };
}

function clearSelectionForPageChange(
  state: DataTableViewState,
): DataTableViewState {
  return state.selection.scope === 'page'
    ? withSelection(state, { scope: 'page', rowIds: [] })
    : state;
}

function clearSelectionForQueryChange(
  state: DataTableViewState,
): DataTableViewState {
  if (state.selection.scope === 'page') {
    return withSelection(state, { scope: 'page', rowIds: [] });
  }
  if (state.selection.scope === 'allMatching') {
    return withSelection(state, { scope: 'explicit', rowIds: [] });
  }
  return state;
}

/**
 * Refuse an all-matching selection when the action's query has changed since
 * selection. Domain actions must call this before a destructive operation.
 */
export function assertDataTableSelectionCurrent(
  selection: DataTableSelection,
  currentQuery: DataTableQueryRevision,
): void {
  if (selection.scope !== 'allMatching') return;
  const current = normalizeQueryRevision(currentQuery);
  if (
    selection.queryFingerprint !== current.queryFingerprint ||
    selection.queryRevision !== current.queryRevision
  ) {
    throw new TypeError(
      'DataTable allMatching selection is stale for the current query revision',
    );
  }
}

function normalizeUniqueColumnIds(values: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const value of values) ids.add(assertColumnId(value));
  return [...ids];
}

function normalizeFilters(
  values: readonly DataTableFilter[],
): DataTableFilter[] {
  const filters = values.map((filter) => {
    const columnId = assertColumnId(filter?.columnId, 'filter column id');
    if (!FILTER_OPERATORS.has(filter?.operator)) {
      throw new TypeError(
        `Unsupported DataTable filter operator: ${String(filter?.operator)}`,
      );
    }
    const needsValue =
      filter.operator !== 'isNull' && filter.operator !== 'isNotNull';
    if (needsValue && !Object.hasOwn(filter, 'value')) {
      throw new TypeError(
        `DataTable filter ${filter.operator} requires a value`,
      );
    }
    const value =
      needsValue && Object.hasOwn(filter, 'value')
        ? canonicalJson(filter.value)
        : undefined;
    return value === undefined
      ? { columnId, operator: filter.operator }
      : { columnId, operator: filter.operator, value };
  });
  return filters.sort((left, right) => {
    const leftKey = `${left.columnId}\u0000${left.operator}\u0000${jsonSignature(
      Object.hasOwn(left, 'value') ? (left.value as DataTableJsonValue) : null,
    )}`;
    const rightKey = `${right.columnId}\u0000${right.operator}\u0000${jsonSignature(
      Object.hasOwn(right, 'value')
        ? (right.value as DataTableJsonValue)
        : null,
    )}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function normalizeSorting(
  values: readonly DataTableSortRule[],
): DataTableSortRule[] {
  const seen = new Set<string>();
  const result: DataTableSortRule[] = [];
  for (const rule of values) {
    const columnId = assertColumnId(rule?.columnId, 'sort column id');
    if (rule?.direction !== 'asc' && rule?.direction !== 'desc') {
      throw new TypeError('DataTable sort directions must be asc or desc');
    }
    if (!seen.has(columnId)) {
      seen.add(columnId);
      result.push({ columnId, direction: rule.direction });
    }
  }
  return result;
}

function normalizeVisibility(
  values: readonly DataTableColumnVisibility[],
): DataTableColumnVisibility[] {
  const entries = new Map<string, boolean>();
  for (const entry of values) {
    const columnId = assertColumnId(entry?.columnId, 'visibility column id');
    if (typeof entry?.visible !== 'boolean') {
      throw new TypeError('DataTable column visibility must be boolean');
    }
    entries.set(columnId, entry.visible);
  }
  return [...entries.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([columnId, visible]) => ({ columnId, visible }));
}

function normalizeWidths(
  values: readonly DataTableColumnWidth[],
): DataTableColumnWidth[] {
  const entries = new Map<string, number>();
  for (const entry of values) {
    const columnId = assertColumnId(entry?.columnId, 'width column id');
    if (
      typeof entry?.width !== 'number' ||
      !Number.isFinite(entry.width) ||
      entry.width <= 0
    ) {
      throw new TypeError(
        'DataTable column widths must be positive finite numbers',
      );
    }
    entries.set(columnId, entry.width);
  }
  return [...entries.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([columnId, width]) => ({ columnId, width }));
}

function normalizePinning(
  values: readonly DataTableColumnPinning[],
): DataTableColumnPinning[] {
  const entries = new Map<string, DataTableColumnPinning['position']>();
  for (const entry of values) {
    const columnId = assertColumnId(entry?.columnId, 'pin column id');
    if (entry?.position !== 'start' && entry?.position !== 'end') {
      throw new TypeError('DataTable column pins must be start or end');
    }
    entries.set(columnId, entry.position);
  }
  return [...entries.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([columnId, position]) => ({ columnId, position }));
}

function normalizeModes(
  modes: Partial<DataTableModes> | undefined,
): DataTableModes {
  const result = { ...DEFAULT_MODES, ...modes };
  for (const mode of Object.values(result)) {
    if (mode !== 'local' && mode !== 'manual') {
      throw new TypeError('DataTable modes must be local or manual');
    }
  }
  return result;
}

function normalizeState(
  state: Partial<DataTableViewState> | undefined,
  columnIds?: readonly string[],
  hiddenColumnIds?: readonly string[],
): DataTableViewState {
  const input = state ?? {};
  const selection = normalizeSelection(
    input.selection,
    input.selectedRowIds ?? DEFAULT_STATE.selectedRowIds,
  );
  const knownColumns = columnIds ? normalizeUniqueColumnIds(columnIds) : null;
  const allowed = knownColumns ? new Set(knownColumns) : null;
  const keepKnown = (columnId: string) => !allowed || allowed.has(columnId);
  const hidden = new Set(
    (hiddenColumnIds ? normalizeUniqueColumnIds(hiddenColumnIds) : []).filter(
      keepKnown,
    ),
  );
  const visibility = normalizeVisibility(
    input.columnVisibility ?? DEFAULT_STATE.columnVisibility,
  ).filter((entry) => keepKnown(entry.columnId));
  const knownVisibility = new Map(
    visibility.map((entry) => [entry.columnId, entry.visible]),
  );

  if (knownColumns) {
    for (const columnId of knownColumns) {
      if (!knownVisibility.has(columnId)) knownVisibility.set(columnId, true);
    }
  }
  for (const columnId of hidden) knownVisibility.set(columnId, false);

  const columnOrder = normalizeUniqueColumnIds(
    input.columnOrder ?? DEFAULT_STATE.columnOrder,
  ).filter(keepKnown);
  if (knownColumns) {
    for (const columnId of knownColumns) {
      if (!columnOrder.includes(columnId)) columnOrder.push(columnId);
    }
  }

  const columnWidths = normalizeWidths(
    input.columnWidths ?? DEFAULT_STATE.columnWidths,
  ).filter((entry) => keepKnown(entry.columnId));
  const columnPinning = normalizePinning(
    input.columnPinning ?? DEFAULT_STATE.columnPinning,
  ).filter((entry) => keepKnown(entry.columnId));

  return {
    search:
      typeof input.search === 'string' ? input.search : DEFAULT_STATE.search,
    filters: normalizeFilters(input.filters ?? DEFAULT_STATE.filters).filter(
      (filter) => keepKnown(filter.columnId),
    ),
    sorting: normalizeSorting(input.sorting ?? DEFAULT_STATE.sorting).filter(
      (sort) => keepKnown(sort.columnId),
    ),
    page: assertPage(input.page ?? DEFAULT_STATE.page),
    pageSize: assertPageSize(input.pageSize ?? DEFAULT_STATE.pageSize),
    columnOrder,
    columnVisibility: normalizeVisibility(
      [...knownVisibility.entries()].map(([columnId, visible]) => ({
        columnId,
        visible,
      })),
    ),
    columnWidths,
    columnPinning,
    selection,
    selectedRowIds: selectedRowIdsFor(selection),
    expandedRowIds: normalizeRowIds(
      input.expandedRowIds ?? DEFAULT_STATE.expandedRowIds,
    ),
  };
}

function stateSignature(state: DataTableViewState): string {
  return jsonSignature(canonicalJson(state));
}

function snapshotSignature(snapshot: DataTableSnapshot): string {
  return jsonSignature(canonicalJson(snapshot));
}

function cloneState(state: DataTableViewState): DataTableViewState {
  return canonicalJson(state) as unknown as DataTableViewState;
}

function cloneSnapshot(snapshot: DataTableSnapshot): DataTableSnapshot {
  return canonicalJson(snapshot) as unknown as DataTableSnapshot;
}

function resetPage(
  state: DataTableViewState,
  changed: boolean,
): DataTableViewState {
  return changed && state.page !== 1 ? { ...state, page: 1 } : state;
}

/** Apply one command without mutating the supplied state. */
export function transitionDataTableState(
  state: DataTableViewState,
  command: DataTableCommand,
): DataTableViewState {
  const current = normalizeState(state);
  let next: DataTableViewState;

  switch (command.type) {
    case 'setSearch': {
      if (typeof command.search !== 'string')
        throw new TypeError('DataTable search must be a string');
      const changed = command.search !== current.search;
      next = resetPage({ ...current, search: command.search }, changed);
      if (changed) next = clearSelectionForQueryChange(next);
      break;
    }
    case 'setFilters': {
      const filters = normalizeFilters(command.filters);
      const changed = jsonSignature(filters) !== jsonSignature(current.filters);
      next = resetPage({ ...current, filters }, changed);
      if (changed) next = clearSelectionForQueryChange(next);
      break;
    }
    case 'setSorting': {
      const sorting = normalizeSorting(command.sorting);
      const changed = jsonSignature(sorting) !== jsonSignature(current.sorting);
      next = resetPage({ ...current, sorting }, changed);
      if (changed) next = clearSelectionForQueryChange(next);
      break;
    }
    case 'toggleSorting': {
      const columnId = assertColumnId(command.columnId, 'sort column id');
      const index = current.sorting.findIndex(
        (rule) => rule.columnId === columnId,
      );
      const previous = index >= 0 ? current.sorting[index] : undefined;
      const toggled: DataTableSortRule | null = !previous
        ? { columnId, direction: 'asc' }
        : previous.direction === 'asc'
          ? { columnId, direction: 'desc' }
          : null;
      const sorting = command.multi
        ? previous
          ? toggled
            ? current.sorting.map((rule, ruleIndex) =>
                ruleIndex === index ? toggled : rule,
              )
            : current.sorting.filter((rule) => rule.columnId !== columnId)
          : [...current.sorting, toggled as DataTableSortRule]
        : toggled
          ? [toggled]
          : [];
      const changed = jsonSignature(sorting) !== jsonSignature(current.sorting);
      next = resetPage({ ...current, sorting }, changed);
      if (changed) next = clearSelectionForQueryChange(next);
      break;
    }
    case 'setPage': {
      const page = assertPage(command.page);
      next = { ...current, page };
      if (page !== current.page) next = clearSelectionForPageChange(next);
      break;
    }
    case 'setPageSize': {
      const pageSize = assertPageSize(command.pageSize);
      const changed = pageSize !== current.pageSize;
      next = resetPage({ ...current, pageSize }, changed);
      if (changed) next = clearSelectionForPageChange(next);
      break;
    }
    case 'setColumnOrder':
      next = {
        ...current,
        columnOrder: normalizeUniqueColumnIds(command.columnIds),
      };
      break;
    case 'setColumnVisibility':
      next = {
        ...current,
        columnVisibility: normalizeVisibility(command.columns),
      };
      break;
    case 'setColumnWidths':
      next = {
        ...current,
        columnWidths: normalizeWidths(command.columns),
      };
      break;
    case 'setColumnWidth': {
      const columnId = assertColumnId(command.columnId, 'width column id');
      const widths = new Map(
        current.columnWidths.map((entry) => [entry.columnId, entry.width]),
      );
      if (command.width === null) {
        widths.delete(columnId);
      } else {
        const normalized = normalizeWidths([
          { columnId, width: command.width },
        ]);
        widths.set(columnId, normalized[0].width);
      }
      next = {
        ...current,
        columnWidths: normalizeWidths(
          [...widths.entries()].map(([id, width]) => ({ columnId: id, width })),
        ),
      };
      break;
    }
    case 'setColumnPinning':
      next = {
        ...current,
        columnPinning: normalizePinning(command.columns),
      };
      break;
    case 'setColumnPin': {
      const columnId = assertColumnId(command.columnId, 'pin column id');
      const pins = new Map(
        current.columnPinning.map((entry) => [entry.columnId, entry.position]),
      );
      if (command.position === null) {
        pins.delete(columnId);
      } else {
        const normalized = normalizePinning([
          { columnId, position: command.position },
        ]);
        pins.set(columnId, normalized[0].position);
      }
      next = {
        ...current,
        columnPinning: normalizePinning(
          [...pins.entries()].map(([id, position]) => ({
            columnId: id,
            position,
          })),
        ),
      };
      break;
    }
    case 'setSelection':
      next = withSelection(current, command.selection);
      break;
    case 'setPageSelection':
      next = withSelection(current, {
        scope: 'page',
        rowIds: command.rowIds,
      });
      break;
    case 'selectAllMatching':
      next = withSelection(current, {
        scope: 'allMatching',
        ...normalizeQueryRevision(command),
        expectedCount: command.expectedCount,
      });
      break;
    case 'setSelectedRows':
      next = withSelection(current, {
        scope: 'explicit',
        rowIds: command.rowIds,
      });
      break;
    case 'toggleRowSelection': {
      if (current.selection.scope === 'allMatching') {
        throw new TypeError(
          'DataTable cannot toggle an individual row while allMatching is active',
        );
      }
      const rowId = assertDataTableRowId(command.rowId);
      const ids = new Map(
        current.selection.rowIds.map((id) => [dataTableRowIdKey(id), id]),
      );
      ids.has(dataTableRowIdKey(rowId))
        ? ids.delete(dataTableRowIdKey(rowId))
        : ids.set(dataTableRowIdKey(rowId), rowId);
      next = withSelection(current, {
        scope: current.selection.scope,
        rowIds: [...ids.values()],
      });
      break;
    }
    case 'setExpandedRows':
      next = { ...current, expandedRowIds: normalizeRowIds(command.rowIds) };
      break;
    case 'toggleRowExpansion': {
      const rowId = assertDataTableRowId(command.rowId);
      const ids = new Map(
        current.expandedRowIds.map((id) => [dataTableRowIdKey(id), id]),
      );
      ids.has(dataTableRowIdKey(rowId))
        ? ids.delete(dataTableRowIdKey(rowId))
        : ids.set(dataTableRowIdKey(rowId), rowId);
      next = { ...current, expandedRowIds: normalizeRowIds([...ids.values()]) };
      break;
    }
    case 'reset':
      next = { ...DEFAULT_STATE };
      break;
    default:
      throw new TypeError(
        `Unsupported DataTable command: ${String((command as { type?: unknown }).type)}`,
      );
  }

  return normalizeState(next);
}

/** Parse persisted state defensively before an external adapter restores it. */
export function hydrateDataTableSnapshot(value: unknown): DataTableSnapshot {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('DataTable snapshot must be a plain object');
  }
  const input = value as Record<string, unknown>;
  if (input.version !== 1 && input.version !== 2 && input.version !== 3)
    throw new TypeError('Unsupported DataTable snapshot version');
  return {
    version: 3,
    modes: normalizeModes(input.modes as Partial<DataTableModes>),
    state: normalizeState(input.state as Partial<DataTableViewState>),
  };
}

/** A headless state owner used by both rendered controls and programmatic commands. */
export class DataTableController {
  private state: DataTableViewState;
  private modes: DataTableModes;
  private columnIds?: string[];
  private hiddenColumnIds?: string[];
  private controlled: boolean;
  private readonly listeners = new Set<DataTableStateListener>();
  private readonly onStateChange?: DataTableControllerOptions['onStateChange'];
  private pendingControlledState?: string;

  constructor(options: DataTableControllerOptions = {}) {
    this.columnIds = options.columnIds
      ? normalizeUniqueColumnIds(options.columnIds)
      : undefined;
    this.hiddenColumnIds = options.hiddenColumnIds
      ? normalizeUniqueColumnIds(options.hiddenColumnIds)
      : undefined;
    this.controlled = options.state !== undefined;
    this.state = normalizeState(
      options.state ?? options.initialState,
      this.columnIds,
      this.hiddenColumnIds,
    );
    this.modes = normalizeModes(options.modes);
    this.onStateChange = options.onStateChange;
  }

  getState(): DataTableViewState {
    return cloneState(this.state);
  }

  getModes(): DataTableModes {
    return { ...this.modes };
  }

  snapshot(): DataTableSnapshot {
    return { version: 3, modes: this.getModes(), state: this.getState() };
  }

  subscribe(listener: DataTableStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Dispatches a serializable command. Controlled controllers emit a proposal only. */
  dispatch(command: DataTableCommand): DataTableTransition {
    const previous = this.snapshot();
    const candidate = normalizeState(
      transitionDataTableState(this.state, command),
      this.columnIds,
      this.hiddenColumnIds,
    );
    const next = {
      version: 3 as const,
      modes: this.getModes(),
      state: candidate,
    };
    const changed = snapshotSignature(previous) !== snapshotSignature(next);
    const transition = {
      command,
      previous,
      next: cloneSnapshot(next),
      changed,
    };
    if (!changed) return transition;

    if (this.controlled) {
      const signature = stateSignature(candidate);
      if (this.pendingControlledState === signature) return transition;
      this.pendingControlledState = signature;
      this.onStateChange?.(cloneState(candidate), command);
      return transition;
    }

    this.state = candidate;
    this.pendingControlledState = undefined;
    this.onStateChange?.(cloneState(candidate), command);
    this.emit(transition);
    return transition;
  }

  /** Supplies state from a controlled host or an external persistence adapter. */
  replaceState(state: DataTableViewStateInput): DataTableTransition {
    const previous = this.snapshot();
    const nextState = normalizeState(
      state,
      this.columnIds,
      this.hiddenColumnIds,
    );
    const next = {
      version: 3 as const,
      modes: this.getModes(),
      state: nextState,
    };
    const changed = snapshotSignature(previous) !== snapshotSignature(next);
    const transition = {
      command: null,
      previous,
      next: cloneSnapshot(next),
      changed,
    };
    this.state = nextState;
    this.pendingControlledState = undefined;
    if (changed) this.emit(transition);
    return transition;
  }

  /** Changes ownership without treating it as a user command. */
  setControlled(controlled: boolean): void {
    this.controlled = controlled;
    if (!controlled) this.pendingControlledState = undefined;
  }

  /** Configures transformation ownership; this remains outside persisted state. */
  setModes(modes: Partial<DataTableModes>): DataTableTransition {
    const previous = this.snapshot();
    this.modes = normalizeModes(modes);
    const next = this.snapshot();
    const changed = snapshotSignature(previous) !== snapshotSignature(next);
    const transition = { command: null, previous, next, changed };
    if (changed) this.emit(transition);
    return transition;
  }

  /** Reconciles stale saved-view column IDs with the renderer's current columns. */
  setColumnIds(
    columnIds: readonly string[],
    hiddenColumnIds: readonly string[] = [],
  ): DataTableTransition {
    const previous = this.snapshot();
    this.columnIds = normalizeUniqueColumnIds(columnIds);
    this.hiddenColumnIds = normalizeUniqueColumnIds(hiddenColumnIds);
    this.state = normalizeState(
      this.state,
      this.columnIds,
      this.hiddenColumnIds,
    );
    const next = this.snapshot();
    const changed = snapshotSignature(previous) !== snapshotSignature(next);
    const transition = { command: null, previous, next, changed };
    if (changed) this.emit(transition);
    return transition;
  }

  /** Clamp against a reliable total. A missing total intentionally does not guess. */
  clampPage(totalRows: number | null | undefined): DataTableTransition {
    if (totalRows === null || totalRows === undefined) {
      const snapshot = this.snapshot();
      return {
        command: null,
        previous: snapshot,
        next: snapshot,
        changed: false,
      };
    }
    if (
      !Number.isFinite(totalRows) ||
      !Number.isInteger(totalRows) ||
      totalRows < 0
    ) {
      throw new TypeError('DataTable totalRows must be a non-negative integer');
    }
    const pageCount = this.state.pageSize
      ? Math.max(1, Math.ceil(totalRows / this.state.pageSize))
      : 1;
    if (this.state.page <= pageCount) {
      const snapshot = this.snapshot();
      return {
        command: null,
        previous: snapshot,
        next: snapshot,
        changed: false,
      };
    }
    return this.dispatch({ type: 'setPage', page: pageCount });
  }

  private emit(transition: DataTableTransition): void {
    for (const listener of [...this.listeners])
      listener(cloneTransition(transition));
  }
}

function cloneTransition(transition: DataTableTransition): DataTableTransition {
  return {
    command: transition.command
      ? (canonicalJson(transition.command) as DataTableCommand)
      : null,
    previous: cloneSnapshot(transition.previous),
    next: cloneSnapshot(transition.next),
    changed: transition.changed,
  };
}

export function createDataTableController(
  options: DataTableControllerOptions = {},
): DataTableController {
  return new DataTableController(options);
}

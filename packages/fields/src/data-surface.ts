import type {
  DataSurfaceActionDescriptor,
  DataSurfaceColumnCapability,
  DataSurfaceColumnDescriptor,
  DataSurfaceColumnOperators,
  DataSurfaceColumnRole,
  DataSurfaceDescriptor,
} from '@happyvertical/smrt-ui/data';
import type {
  ResolvedFieldPolicy,
  ResolvedObjectFieldPolicy,
} from './types.js';

/** Optional host metadata for columns that do not come from a model field. */
export interface FieldPolicyDataSurfaceOptions {
  /** Map domain column ids to manifest field names without changing column ids. */
  fieldNameByColumnId?: Readonly<Record<string, string>>;
  /** Static visibility is a host constraint and can only be narrowed. */
  staticHiddenColumnIds?: readonly string[];
  /** Structural roles are always retained when policy filters data columns. */
  roleByColumnId?: Readonly<Record<string, DataSurfaceColumnRole>>;
  /** Explicit host authorization for otherwise restricted column ids. */
  authorizedColumnIds?: readonly string[];
}

const POLICY_NARROWED_CAPABILITIES = new Set<DataSurfaceColumnCapability>([
  'read',
  'search',
  'filter',
  'sort',
  'project',
]);

function policyFieldName(
  column: DataSurfaceColumnDescriptor,
  options: FieldPolicyDataSurfaceOptions,
): string {
  return (
    column.fieldName ?? options.fieldNameByColumnId?.[column.id] ?? column.id
  );
}

function roleForColumn(
  column: DataSurfaceColumnDescriptor,
  options: FieldPolicyDataSurfaceOptions,
): DataSurfaceColumnRole | undefined {
  return column.role ?? options.roleByColumnId?.[column.id];
}

function isSensitiveColumn(column: DataSurfaceColumnDescriptor): boolean {
  return column.sensitivity === 'sensitive' || column.sensitivity === 'secret';
}

function isAuthorizedColumn(
  column: DataSurfaceColumnDescriptor,
  options: FieldPolicyDataSurfaceOptions,
): boolean {
  return options.authorizedColumnIds?.includes(column.id) === true;
}

function isStructuralColumn(
  column: DataSurfaceColumnDescriptor,
  options: FieldPolicyDataSurfaceOptions,
): boolean {
  const role = roleForColumn(column, options);
  return (
    role === 'computed' ||
    role === 'row-key' ||
    role === 'selection' ||
    role === 'action'
  );
}

function narrowOperators(
  operators: DataSurfaceColumnOperators | undefined,
  hidden: boolean,
): DataSurfaceColumnOperators | undefined {
  if (!operators) return undefined;
  if (hidden) return {};
  return {
    ...(operators.search ? { search: [...operators.search] } : {}),
    ...(operators.filter ? { filter: [...operators.filter] } : {}),
    ...(operators.sort ? { sort: [...operators.sort] } : {}),
  };
}

function narrowCapabilities(
  capabilities: readonly DataSurfaceColumnCapability[],
  hidden: boolean,
): DataSurfaceColumnCapability[] {
  if (hidden) return [];
  return capabilities.filter((capability) =>
    POLICY_NARROWED_CAPABILITIES.has(capability),
  );
}

function policyColumn(
  column: DataSurfaceColumnDescriptor,
  policy: ResolvedFieldPolicy | undefined,
  hiddenByStaticPolicy: boolean,
  structural: boolean,
  restricted: boolean,
): DataSurfaceColumnDescriptor {
  const hidden = hiddenByStaticPolicy || policy?.visibility === 'hidden';

  // Computed, selection, action, and row-key columns have no manifest field
  // and are intentionally copied through unchanged when unrestricted. Hidden
  // structural columns still must not remain discoverable or executable.
  if (structural) {
    if (hidden || restricted) {
      return {
        ...column,
        visibility: 'hidden',
        readable: false,
        capabilities: [],
        operators: {},
        searchOperators: [],
        filterOperators: [],
        sortOperators: [],
      };
    }
    const explicitlyAuthorized =
      !restricted && (column.readable === false || isSensitiveColumn(column));
    return {
      ...column,
      ...(explicitlyAuthorized ? { readable: true } : {}),
    };
  }

  if (!policy) {
    const unreadable = hiddenByStaticPolicy || restricted;
    const explicitlyAuthorized = column.readable === false && !restricted;
    return {
      ...column,
      ...(unreadable ? { visibility: 'hidden' as const } : {}),
      ...(column.readable === undefined &&
      (column.sensitivity === 'sensitive' || column.sensitivity === 'secret')
        ? { readable: true }
        : {}),
      ...(explicitlyAuthorized ? { readable: true } : {}),
      ...(unreadable
        ? {
            readable: false,
            capabilities: narrowCapabilities(column.capabilities, true),
            ...(column.operators ? { operators: {} } : {}),
            ...(column.searchOperators ? { searchOperators: [] } : {}),
            ...(column.filterOperators ? { filterOperators: [] } : {}),
            ...(column.sortOperators ? { sortOperators: [] } : {}),
          }
        : {}),
    };
  }

  const unreadable = hidden || restricted;
  const label = policy.label ?? column.label;
  const description = policy.help ?? column.description;
  return {
    ...column,
    label,
    ...(description ? { description } : {}),
    ...(policy.order === null ? {} : { order: policy.order }),
    visibility: policy.visibility,
    readable: !unreadable,
    capabilities: narrowCapabilities(column.capabilities, unreadable),
    ...(narrowOperators(column.operators, unreadable)
      ? { operators: narrowOperators(column.operators, unreadable) }
      : {}),
    ...(column.searchOperators
      ? { searchOperators: unreadable ? [] : [...column.searchOperators] }
      : {}),
    ...(column.filterOperators
      ? { filterOperators: unreadable ? [] : [...column.filterOperators] }
      : {}),
    ...(column.sortOperators
      ? { sortOperators: unreadable ? [] : [...column.sortOperators] }
      : {}),
    ...(unreadable ? { visibility: 'hidden' as const } : {}),
  };
}

function actionUsesHiddenColumn(
  action: DataSurfaceActionDescriptor,
  hiddenColumnIds: ReadonlySet<string>,
): boolean {
  return (
    action.columnIds?.some((columnId) => hiddenColumnIds.has(columnId)) ?? false
  );
}

/**
 * Apply an effective field policy to a mounted DataSurface descriptor.
 *
 * This adapter is deliberately outside smrt-ui: the UI contract remains
 * domain-neutral while fields owns the policy-to-surface semantics. Static
 * host constraints and policy restrictions only remove capabilities; they
 * never reveal a field or rename a domain column id.
 */
export function policyToDataSurfaceDescriptor(
  policy: ResolvedObjectFieldPolicy,
  descriptor: DataSurfaceDescriptor,
  options: FieldPolicyDataSurfaceOptions = {},
): DataSurfaceDescriptor {
  const staticHidden = new Set(options.staticHiddenColumnIds ?? []);
  const rowKey = descriptor.rowKey;
  const mapped = descriptor.columns.map((column, index) => {
    const field = policy.fields[policyFieldName(column, options)];
    const structural = isStructuralColumn(column, options);
    const restricted =
      (column.readable === false || isSensitiveColumn(column)) &&
      !isAuthorizedColumn(column, options);
    const rowKeyHidden =
      column.id === rowKey &&
      (staticHidden.has(column.id) ||
        column.visibility === 'hidden' ||
        field?.visibility === 'hidden');
    const effective = policyColumn(
      column,
      field,
      staticHidden.has(column.id) || column.visibility === 'hidden',
      structural,
      restricted,
    );
    return { column, effective, field, structural, index, rowKeyHidden };
  });

  // A hidden data field must not be describable or restorable. The row key is
  // the one technical exception: mounted surfaces must retain stable identity,
  // but it has no read/query capabilities when policy-hidden.
  const hiddenColumnIds = new Set<string>();
  const columns = mapped
    .filter(({ column, effective }) => {
      const hidden =
        staticHidden.has(column.id) ||
        column.visibility === 'hidden' ||
        effective.visibility === 'hidden';
      if (hidden && column.id !== rowKey) hiddenColumnIds.add(column.id);
      return !hidden || column.id === rowKey;
    })
    .sort((left, right) => {
      if (left.column.id === rowKey) return -1;
      if (right.column.id === rowKey) return 1;
      const leftOrder = left.effective.order ?? Number.POSITIVE_INFINITY;
      const rightOrder = right.effective.order ?? Number.POSITIVE_INFINITY;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ effective, column, rowKeyHidden }) =>
      column.id === rowKey && (hiddenColumnIds.has(column.id) || rowKeyHidden)
        ? {
            ...effective,
            visibility: 'hidden' as const,
            readable: false,
            capabilities: [],
            operators: {},
            searchOperators: [],
            filterOperators: [],
            sortOperators: [],
          }
        : effective,
    );

  const visibleIds = new Set(columns.map((column) => column.id));
  const hasCapability = (
    columnId: string,
    capability: DataSurfaceColumnCapability,
  ): boolean => {
    const column = columns.find((candidate) => candidate.id === columnId);
    return column?.capabilities.includes(capability) ?? false;
  };
  const allowlist = (
    ids: readonly string[] | undefined,
    capability: DataSurfaceColumnCapability,
  ): string[] | undefined =>
    ids
      ? ids.filter(
          (columnId) =>
            visibleIds.has(columnId) && hasCapability(columnId, capability),
        )
      : undefined;

  const actions = descriptor.actions
    .filter((action) => !actionUsesHiddenColumn(action, hiddenColumnIds))
    .map((action) => ({
      ...action,
      ...(action.columnIds
        ? {
            columnIds: action.columnIds.filter((columnId) =>
              visibleIds.has(columnId),
            ),
          }
        : {}),
    }));

  return {
    ...descriptor,
    columns,
    query: {
      ...descriptor.query,
      projectableColumnIds:
        allowlist(descriptor.query.projectableColumnIds, 'project') ?? [],
      ...(allowlist(descriptor.query.searchableColumnIds, 'search')
        ? {
            searchableColumnIds: allowlist(
              descriptor.query.searchableColumnIds,
              'search',
            ),
          }
        : descriptor.query.searchableColumnIds
          ? { searchableColumnIds: [] }
          : {}),
      ...(allowlist(descriptor.query.filterableColumnIds, 'filter')
        ? {
            filterableColumnIds: allowlist(
              descriptor.query.filterableColumnIds,
              'filter',
            ),
          }
        : descriptor.query.filterableColumnIds
          ? { filterableColumnIds: [] }
          : {}),
      ...(allowlist(descriptor.query.sortableColumnIds, 'sort')
        ? {
            sortableColumnIds: allowlist(
              descriptor.query.sortableColumnIds,
              'sort',
            ),
          }
        : descriptor.query.sortableColumnIds
          ? { sortableColumnIds: [] }
          : {}),
    },
    actions,
  };
}

/** Descriptive alias for hosts that treat policy application as a transform. */
export const applyFieldPolicyToDataSurface = policyToDataSurfaceDescriptor;

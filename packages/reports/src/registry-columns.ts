import { ObjectRegistry } from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';

export async function fieldColumn(
  className: string,
  requested: string,
): Promise<string | null> {
  const fields = await ObjectRegistry.getAllFields(className);
  const requestedColumn = toSnakeCase(requested);

  for (const [fieldName] of fields.entries()) {
    if (fieldName === requested || toSnakeCase(fieldName) === requestedColumn) {
      return requestedColumn;
    }
  }

  return null;
}

export async function tenantColumn(className: string): Promise<string | null> {
  const registered = ObjectRegistry.getClass(className);
  const configuredField = registered?.tenantScopedConfig?.field;
  if (configuredField) {
    return toSnakeCase(configuredField);
  }

  const fields = await ObjectRegistry.getAllFields(className);
  for (const [fieldName, field] of fields.entries()) {
    if (field?._meta?.__tenancy?.isTenantIdField) {
      return toSnakeCase(fieldName);
    }
  }

  const tenantIdField = await fieldColumn(className, 'tenantId');
  return tenantIdField;
}

type SchemaTables = Record<
  string,
  { columns?: Record<string, { type?: unknown }> }
>;

/**
 * Reads column types for one report build. The tables come from the same
 * merged assembly migration uses (manifest columns plus runtime overlays such
 * as `tenantScoped`'s tenant_id), built at most once per build. If assembling
 * them fails for a reason elsewhere in the registry, types fall back to each
 * class's own built schema, and a column neither describes is unknown.
 */
export function columnTypeReader(): (
  className: string,
  column: string,
) => string | null {
  let tables: SchemaTables | null | undefined;
  const merged = (): SchemaTables | null => {
    if (tables === undefined) {
      try {
        tables = ObjectRegistry.getAllSchemasAsDefinitions() as SchemaTables;
      } catch {
        tables = null;
      }
    }
    return tables;
  };
  const upper = (type: unknown) =>
    typeof type === 'string' ? type.toUpperCase() : null;

  return (className, column) => {
    const table = ObjectRegistry.getTableName(className);
    const fromTable = table
      ? upper(merged()?.[table]?.columns?.[column]?.type)
      : null;
    if (fromTable) return fromTable;
    // An STI child's columns live on its base table's schema.
    const names = [className];
    if (ObjectRegistry.getTableStrategy(className) === 'sti') {
      const base = ObjectRegistry.getSTIBase(className);
      if (base) names.push(base);
    }
    for (const name of names) {
      const type = upper(
        ObjectRegistry.getSchema(name)?.columns?.[column]?.type,
      );
      if (type) return type;
    }
    return null;
  };
}

/**
 * Whether two key columns must be compared as text: one is UUID and the other
 * TEXT (a text reference against a uuid id, which Postgres has no operator
 * for). Every other pair, same-typed, undescribed or another mismatch,
 * compares as it is, so indexes still serve the join and numeric keys are
 * never compared by their text form.
 */
export function compareAsText(
  types: (className: string, column: string) => string | null,
  left: { className: string; column: string },
  right: { className: string; column: string },
): boolean {
  const pair = [
    types(left.className, left.column),
    types(right.className, right.column),
  ];
  return pair.includes('UUID') && pair.includes('TEXT');
}

/** The registry field properties that decide who may read a column. */
export interface PolicyField {
  sensitive?: boolean;
  readPermission?: string;
  sensitivity?: unknown;
  _meta?: Record<string, unknown>;
}

export function fieldPolicy(field: PolicyField | undefined): {
  sensitive: boolean;
  readPermission?: string;
} {
  const meta = field?._meta ?? {};
  const sensitivity = [field?.sensitivity, meta.sensitivity].find(
    (value): value is string => typeof value === 'string',
  );
  return {
    sensitive:
      field?.sensitive === true ||
      meta.sensitive === true ||
      sensitivity === 'sensitive' ||
      sensitivity === 'secret',
    readPermission:
      typeof field?.readPermission === 'string'
        ? field.readPermission
        : typeof meta.readPermission === 'string'
          ? meta.readPermission
          : undefined,
  };
}

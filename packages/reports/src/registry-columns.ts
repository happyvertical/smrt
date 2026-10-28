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

/**
 * The schema SQL type of a class's column (upper-case, e.g. `UUID`, `TEXT`),
 * or null when no schema describes it. Reads the class's built (manifest)
 * schema, and an STI child's base schema since its columns live there; a class
 * registered at runtime without one falls back to the table as migration
 * assembles it from every registered class.
 */
export function columnSqlType(
  className: string,
  column: string,
): string | null {
  const names = [className];
  if (ObjectRegistry.getTableStrategy(className) === 'sti') {
    const base = ObjectRegistry.getSTIBase(className);
    if (base) names.push(base);
  }
  for (const name of names) {
    const type = ObjectRegistry.getSchema(name)?.columns?.[column]?.type;
    if (typeof type === 'string') return type.toUpperCase();
  }
  const table = ObjectRegistry.getTableName(className);
  const merged = table
    ? ObjectRegistry.getAllSchemasAsDefinitions()[table]?.columns?.[column]
        ?.type
    : undefined;
  return typeof merged === 'string' ? merged.toUpperCase() : null;
}

/**
 * Whether two columns must be compared as text: their built-schema types are
 * both known and differ (a text reference against a uuid id, which Postgres
 * has no operator for). Same-typed or undescribed columns compare as they are,
 * so their indexes still serve the join.
 */
export function compareAsText(
  left: { className: string; column: string },
  right: { className: string; column: string },
): boolean {
  const leftType = columnSqlType(left.className, left.column);
  const rightType = columnSqlType(right.className, right.column);
  return leftType !== null && rightType !== null && leftType !== rightType;
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

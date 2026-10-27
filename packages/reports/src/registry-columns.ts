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

/** Declared inline edits of one linked record; no duplicate persisted columns. */
import type { FieldDefinition } from './scanner/types.js';

export interface WriteThroughLink {
  /** Public scalar fields of the target, exposed under their own names. */
  fields: string[];
  /** Explicit subtype for newly created targets, independent of public createType. */
  createType?: string;
  /** Owning-model adapters for non-column fields (for example Profile metadata). */
  virtualFields?: Record<
    string,
    {
      type: 'text';
      description?: string;
      ui?: { widget?: 'phone' | 'email'; basic?: boolean };
    }
  >;
}
export type WriteThroughConfig = Record<string, WriteThroughLink>;

const RESERVED =
  /^(?:id|slug|context|tenantId|createdAt|updatedAt|displayLabel|createType|constructor|prototype|__proto__)$/;

/** Shared fail-closed validation for manifests, runtime writes and tool schemas. */
export function writeThroughFields(
  fields: Record<string, FieldDefinition>,
  config: WriteThroughConfig | undefined,
  targetFields: (via: string) => Record<string, FieldDefinition>,
): Record<string, FieldDefinition> {
  const result: Record<string, FieldDefinition> = {};
  for (const [via, link] of Object.entries(config ?? {})) {
    const edge = fields[via];
    if (
      !edge ||
      !['foreignKey', 'crossPackageRef'].includes(edge.type) ||
      edge.sensitive ||
      edge.transient ||
      edge.readonly ||
      edge.readPermission ||
      edge._meta?.sensitive ||
      edge._meta?.transient ||
      edge._meta?.readonly ||
      edge._meta?.readPermission
    ) {
      throw new Error(
        `writeThrough.${via} must be a public writable reference`,
      );
    }
    if (
      !Array.isArray(link.fields) ||
      (link.createType !== undefined && typeof link.createType !== 'string')
    )
      throw new Error(`Invalid writeThrough.${via} declaration`);
    const target = targetFields(via);
    for (const name of [
      ...link.fields,
      ...Object.keys(link.virtualFields ?? {}),
    ]) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) ||
        RESERVED.test(name) ||
        fields[name] ||
        result[name]
      )
        throw new Error(
          `writeThrough field '${name}' collides with a field or reserved name`,
        );
      const definition: FieldDefinition | undefined =
        link.virtualFields?.[name] ?? target[name];
      if (
        !definition ||
        !['text', 'boolean', 'integer', 'decimal', 'datetime'].includes(
          definition.type,
        ) ||
        definition.sensitive ||
        definition.transient ||
        definition.readonly ||
        definition.readPermission ||
        definition._meta?.sensitive ||
        definition._meta?.transient ||
        definition._meta?.readonly ||
        definition._meta?.readPermission
      )
        throw new Error(
          `writeThrough field '${name}' must be a public writable scalar`,
        );
      result[name] = {
        ...definition,
        required: false,
        _meta: {
          ...('_meta' in definition ? definition._meta : {}),
          ui: {
            ...('_meta' in definition
              ? definition._meta?.ui
              : link.virtualFields?.[name]?.ui),
            basic: true,
            order: -100 + Object.keys(result).length,
          },
        },
      };
    }
  }
  return result;
}

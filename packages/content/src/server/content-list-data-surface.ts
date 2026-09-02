/** Principal-bound, silent ContentList query discovery and execution (#2456). */

import type {
  DataSurfaceDefinition,
  DataSurfaceExecutionContext,
  DataSurfaceSchema,
} from '@happyvertical/smrt-agents';
import type { DataQuerySchema } from '@happyvertical/smrt-types';
import {
  assertContentQuerySchema,
  buildContentQuerySchema,
  CONTENT_QUERY_CLASS_NAME,
  type ContentQueryCollection,
  type ContentQueryScope,
  executeContentQuery,
} from '../content-query.js';

export const CONTENT_LIST_DATA_SURFACE_ID = 'content-list';
export const CONTENT_LIST_DATA_SURFACE_COLLECTION = 'contents';

export interface ContentListDataSurfaceOptions {
  /** Stable catalog id. Defaults to the mounted ContentList surface id. */
  id?: string;
  /** Permission-catalog collection checked by the generic agent tools. */
  collectionName?: string;
  label?: string;
  description?: string;
  metadata?: NonNullable<DataSurfaceDefinition['metadata']>;
  /** Resolve a collection from the live principal context, never model input. */
  collection:
    | ContentQueryCollection
    | ((
        context: DataSurfaceExecutionContext,
      ) => ContentQueryCollection | Promise<ContentQueryCollection>);
  /** Trusted application narrowing applied in addition to tenant isolation. */
  scope?:
    | ContentQueryScope
    | ((
        context: DataSurfaceExecutionContext,
      ) =>
        | ContentQueryScope
        | undefined
        | Promise<ContentQueryScope | undefined>);
  /** Trusted policy override; defaults to the canonical Content query schema. */
  schema?: DataSurfaceSchema;
}

function requiredName(
  value: string | undefined,
  fallback: string,
  label: string,
) {
  const resolved = value ?? fallback;
  if (resolved.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return resolved;
}

function querySchema(schema: DataSurfaceSchema): DataQuerySchema {
  return {
    ...schema,
    fields: schema.fields.map(
      ({
        sensitive: _sensitive,
        readPermission: _readPermission,
        metadata: _metadata,
        ...field
      }) => field,
    ),
  };
}

async function resolveCollection(
  options: ContentListDataSurfaceOptions,
  context: DataSurfaceExecutionContext,
): Promise<ContentQueryCollection> {
  return typeof options.collection === 'function'
    ? options.collection(context)
    : options.collection;
}

async function resolveScope(
  options: ContentListDataSurfaceOptions,
  context: DataSurfaceExecutionContext,
): Promise<ContentQueryScope | undefined> {
  return typeof options.scope === 'function'
    ? options.scope(context)
    : options.scope;
}

/**
 * Build one server-owned ContentList surface for `data.discover`,
 * `data.inspect`, and silent/background `data.query` calls.
 *
 * The returned executor resolves its collection and application scope from the
 * live principal context. The request can only narrow that trusted scope, and
 * every projection/count/facet/page still passes through `executeContentQuery`.
 */
export async function createContentListDataSurfaceDefinition(
  options: ContentListDataSurfaceOptions,
): Promise<DataSurfaceDefinition> {
  const schema = options.schema ?? (await buildContentQuerySchema());
  const executableSchema = querySchema(schema);
  assertContentQuerySchema(executableSchema);

  return {
    id: requiredName(
      options.id,
      CONTENT_LIST_DATA_SURFACE_ID,
      'ContentList data surface id',
    ),
    collection: requiredName(
      options.collectionName,
      CONTENT_LIST_DATA_SURFACE_COLLECTION,
      'ContentList permission collection',
    ),
    className: CONTENT_QUERY_CLASS_NAME,
    label: options.label ?? 'Contents',
    description:
      options.description ??
      'Bounded, tenant-safe content rows, counts, facets, and continuations.',
    metadata: {
      domain: 'content',
      adapter: 'ContentList',
      views: ['grid', 'detailed', 'compact'],
      queryModes: ['rows', 'count', 'facets'],
      ...options.metadata,
    },
    schema,
    execute: async (_surface, request, context) =>
      executeContentQuery(await resolveCollection(options, context), request, {
        schema: executableSchema,
        scope: await resolveScope(options, context),
      }),
  };
}

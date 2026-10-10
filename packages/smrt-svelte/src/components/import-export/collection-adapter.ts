import {
  type SmrtCrudFetchers,
  type SmrtWebCollectionDefinition,
  unwrapItemResult,
  unwrapListResult,
} from '@happyvertical/smrt-web';
import {
  type FieldsFromDefinitionOptions,
  fieldsFromCollectionDefinition,
} from './fields.js';
import type { ImportExportField } from './types.js';

export interface LoadRowsOptions {
  signal?: AbortSignal;
  /** Rows per request. Default 500. */
  pageSize?: number;
  /** Safety cap on exported rows. Default 50000. */
  maxRows?: number;
  /** Extra list params (for example `where` or `orderBy`) merged into each page request. */
  query?: Record<string, unknown>;
}

export interface CollectionImportExport {
  fields: ImportExportField[];
  createRecord: (
    values: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  loadRows: (
    options?: LoadRowsOptions,
  ) => Promise<Array<Record<string, unknown>>>;
}

export class ExportLimitError extends Error {
  readonly maxRows: number;
  constructor(maxRows: number) {
    super(`Export stopped at the ${maxRows} row limit`);
    this.name = 'ExportLimitError';
    this.maxRows = maxRows;
  }
}

/**
 * Bind the import/export UI to a collection's generated CRUD fetchers. Rows go
 * through the same REST create/list routes (and so the same authorization,
 * tenancy, and validation) as any other client; this layer never writes SQL.
 *
 * `loadRows` pages with `limit`/`offset` and fails with
 * {@link ExportLimitError} rather than silently truncating at `maxRows`.
 */
export function createCollectionImportExport(input: {
  definition: Pick<SmrtWebCollectionDefinition, 'name' | 'fields'>;
  fetchers: Pick<SmrtCrudFetchers, 'list' | 'create'>;
  fieldOptions?: FieldsFromDefinitionOptions;
}): CollectionImportExport {
  const { definition, fetchers } = input;
  return {
    fields: fieldsFromCollectionDefinition(definition, input.fieldOptions),
    async createRecord(values) {
      const result = await fetchers.create(values);
      return unwrapItemResult(result, `create(${definition.name})`);
    },
    async loadRows(options = {}) {
      const pageSize = Math.max(1, options.pageSize ?? 500);
      const maxRows = options.maxRows ?? 50_000;
      const rows: Array<Record<string, unknown>> = [];
      for (let offset = 0; ; offset += pageSize) {
        options.signal?.throwIfAborted();
        const page = unwrapListResult(
          await fetchers.list({ ...options.query, limit: pageSize, offset }),
          definition.name,
        );
        rows.push(...page);
        if (rows.length > maxRows) throw new ExportLimitError(maxRows);
        if (page.length < pageSize) return rows;
      }
    },
  };
}

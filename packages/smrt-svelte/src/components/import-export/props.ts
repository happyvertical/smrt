import type {
  ExportFile,
  ImportExportField,
  ImportRunResult,
} from './types.js';

export interface ImportExportProps {
  /** Columns, usually from `fieldsFromCollectionDefinition` (manifest + resolved policy). */
  fields: ImportExportField[];
  /** Heading context, for example the collection's plural label. */
  collectionLabel?: string;
  /**
   * Persist one validated row. Providing it enables import; reject to fail just
   * that row. `createCollectionImportExport(...).createRecord` fits.
   */
  createRecord?: (values: Record<string, unknown>) => Promise<unknown>;
  /**
   * Load the rows to export. Providing it enables export. Throw to report a
   * failure. `createCollectionImportExport(...).loadRows` fits.
   */
  loadRows?: (options: {
    signal?: AbortSignal;
  }) => Promise<Array<Record<string, unknown>>>;
  /** Base name for exported files. Default `export`. */
  filename?: string;
  /** Largest accepted file in bytes. Default 5 MiB. */
  maxFileBytes?: number;
  /** Most data rows accepted per file. Default 10,000. */
  maxRows?: number;
  /** Parallel create requests. Default 3. */
  concurrency?: number;
  /** Which sections to show. Default `both`; a missing callback hides its side. */
  mode?: 'both' | 'import' | 'export';
  /** Receives every generated file. Default triggers a browser download. */
  ondownload?: (file: ExportFile) => void;
  /** Called after an import run finishes (including a stopped run). */
  onimported?: (result: ImportRunResult) => void;
}

/**
 * Shared types for the import/export module. Everything here is plain data so
 * the CSV layer (csv.ts, validate.ts, export.ts, runner.ts) runs in Node with
 * no Svelte, DOM, or Provider.
 */

/** Column value kinds the importer understands (a superset-free mapping of the manifest types). */
export type ImportExportFieldType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'reference'
  | 'enum';

/** Presentation hint that also drives light validation (`email`, `url`). */
export type ImportExportWidget =
  | 'textarea'
  | 'currency'
  | 'email'
  | 'url'
  | 'phone';

/**
 * One importable/exportable column of a collection. Derive it from a
 * collection definition and resolved field policy with
 * `fieldsFromCollectionDefinition`, or author it by hand.
 */
export interface ImportExportField {
  /** Property name on the record (also the default CSV header). */
  name: string;
  /** Human label (default for header matching and `headerStyle: 'label'`). */
  label: string;
  type: ImportExportFieldType;
  /** Required with no default: an empty or unmapped cell fails validation. */
  required: boolean;
  /** False for read-only, locked, hidden, or system fields: never written by import. */
  importable: boolean;
  /** False for hidden or tenant-internal fields: never written to an export. */
  exportable: boolean;
  /** Allowed values for `type: 'enum'` (matched case-insensitively). */
  options?: readonly string[];
  widget?: ImportExportWidget;
  /** Help text surfaced beside the mapping row. */
  help?: string;
  /** A resolved policy/manifest default; fills empty or unmapped cells. */
  hasDefault?: boolean;
  defaultValue?: unknown;
  /**
   * An org-locked field: not importable, but its resolved default is still
   * written to every record. A non-importable field that is not `locked`
   * (hidden, tenant, system) never enters the payload, defaults included.
   */
  locked?: boolean;
  /** Reject a second row repeating the same value within one file. */
  unique?: boolean;
  /** Extra header spellings the auto-mapper should accept. */
  aliases?: readonly string[];
}

/** A parsed delimited file: header row plus data rows with their file line numbers. */
export interface ParsedTable {
  delimiter: string;
  headers: string[];
  rows: string[][];
  /** 1-based file line each entry of `rows` starts on (for error reports). */
  lines: number[];
}

/** Per-source-column target: a field name, or null to skip the column. */
export type ColumnMapping = ReadonlyArray<string | null>;

export type ImportIssueCode =
  | 'required'
  | 'invalid-integer'
  | 'out-of-range'
  | 'invalid-decimal'
  | 'invalid-boolean'
  | 'invalid-datetime'
  | 'invalid-json'
  | 'invalid-enum'
  | 'invalid-email'
  | 'invalid-url'
  | 'invalid-reference'
  | 'duplicate-value'
  | 'duplicate-mapping'
  | 'unmapped-required'
  | 'extra-cells'
  | 'import-failed';

/** One validation or import problem. `line` is 0 for mapping-level issues. */
export interface ImportIssue {
  code: ImportIssueCode;
  /** 1-based file line of the offending record; 0 when not row-specific. */
  line: number;
  field?: string;
  /** Source column header the value came from. */
  column?: string;
  /** The offending raw cell (truncated to 200 chars). */
  value?: string;
  /** Extra context (the server error for `import-failed`, the allowed values for `invalid-enum`). */
  detail?: string;
}

/** A row that passed validation, ready for `createRecord`. */
export interface ValidRecord {
  /** Index into the parsed `rows`. */
  index: number;
  line: number;
  values: Record<string, unknown>;
}

export interface ValidationResult {
  totalRows: number;
  records: ValidRecord[];
  /** Row-level issues, capped at `maxIssues`; see `issuesTruncated`. */
  issues: ImportIssue[];
  issuesTruncated: boolean;
  /** Mapping-level issues (duplicate target, unmapped required field). */
  mappingIssues: ImportIssue[];
  invalidRows: number;
}

export interface ImportRunResult {
  attempted: number;
  created: number;
  failed: ImportIssue[];
  aborted: boolean;
}

export interface ExportFile {
  filename: string;
  mimeType: string;
  content: string;
  rowCount: number;
  columnCount: number;
}

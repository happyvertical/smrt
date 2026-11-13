/** Typed refusals. Every one carries a stable `code`; none wraps an adapter error. */

export type ImportPlanErrorCode =
  | 'plan-not-data'
  | 'plan-too-large'
  | 'unsupported-version'
  | 'invalid-shape'
  | 'unknown-key'
  | 'invalid-key'
  | 'reserved-key'
  | 'duplicate-key'
  | 'limit-exceeded'
  | 'invalid-value'
  | 'invalid-source'
  | 'field-source'
  | 'unknown-field'
  | 'unknown-table'
  | 'reference-mismatch'
  | 'reference-cycle'
  | 'invalid-expression'
  | 'expression-column'
  | 'expression-type';

/** A plan was refused. `path` locates the offending value, e.g. `tables[0].fields[2].key`. */
export class ImportPlanError extends Error {
  readonly code: ImportPlanErrorCode;
  readonly path: string;
  constructor(code: ImportPlanErrorCode, path: string, message: string) {
    super(`${path || 'plan'}: ${message}`);
    this.name = 'ImportPlanError';
    this.code = code;
    this.path = path;
  }
}

export type ImportRunErrorCode =
  | 'cells-over-limit'
  | 'rows-over-limit'
  | 'work-over-limit'
  | 'target-not-empty'
  | 'source-invalid';

/** A workbook or target was refused before anything was written. */
export class ImportRunError extends Error {
  readonly code: ImportRunErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(
    code: ImportRunErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ImportRunError';
    this.code = code;
    this.detail = detail;
  }
}

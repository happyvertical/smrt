/**
 * The handler's argument schema or `validate` refused explicit arguments.
 * Review hosts may report this to the reviewer as a correctable rejection;
 * every other preview failure stays a denial.
 */
export class HandlerArgumentsInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandlerArgumentsInvalidError';
  }
}
/** Current generation is authorized, but its immutable configuration or candidate revisions are stale. */
export class GenerationSnapshotStaleError extends Error {
  constructor() {
    super('Generation snapshot stale');
    this.name = 'GenerationSnapshotStaleError';
  }
}

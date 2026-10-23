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
/**
 * An interpretation was requested for an extraction that is no longer the
 * item's latest (for example a slow host appending after a reviewer retried).
 * Nothing was appended; the newer extraction's own interpretation proceeds.
 */
export class GenerationSourceStaleError extends Error {
  constructor() {
    super('Generation source superseded');
    this.name = 'GenerationSourceStaleError';
  }
}
/** Current generation is authorized, but its immutable configuration or candidate revisions are stale. */
export class GenerationSnapshotStaleError extends Error {
  constructor() {
    super('Generation snapshot stale');
    this.name = 'GenerationSnapshotStaleError';
  }
}

import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * One version of the user app's definition (shell.db). Never deleted: an old
 * version's migration is marked `purged` once its archives are cleaned up.
 * Written only by `ShellVersionStore`; no generated surface.
 */
@smrt({
  tableName: 'app_versions',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
})
export class AppVersion extends SmrtObject {
  @field({ type: 'integer', required: true })
  version: number = 0;

  /** Parent version, `-1` for none (the first version). */
  @field({ type: 'integer' })
  parent: number = -1;

  @field({ type: 'text' })
  author: string = '';

  @field({ type: 'text' })
  summary: string = '';

  /** The whole definition, JSON text. */
  @field({ type: 'text' })
  definition: string = '';

  /** `{ steps, purged? }` JSON text, or empty for a change with no migration. */
  @field({ type: 'text' })
  migration: string = '';

  @field({ type: 'text' })
  createdAt: string = '';

  @field({ type: 'boolean' })
  purged: boolean = false;
}

export class AppVersionCollection extends SmrtCollection<AppVersion> {
  static readonly _itemClass = AppVersion;
}

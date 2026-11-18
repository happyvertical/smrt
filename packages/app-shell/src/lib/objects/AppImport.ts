import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/** Durable ownership and proof for a workbook; bytes live under imports/<id>.xlsx. */
@smrt({
  tableName: 'app_imports',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
})
export class AppImport extends SmrtObject {
  @field({ type: 'text', required: true, requiredFor: 'workflow-state' })
  ownerId: string = '';
  @field({ type: 'text', required: true, requiredFor: 'tenant-scope' })
  tenantId: string = '';
  @field({ type: 'text' })
  runId: string = '';
  @field({ type: 'text' })
  draftId: string = '';
  @field({ type: 'text' })
  status: string = 'reading';
  @field({ type: 'text' })
  stage: string = 'reading';
  @field({ type: 'integer' })
  maxCells: number = 0;
  @field({ type: 'text' })
  detail: string = '{}';
}
export class AppImportCollection extends SmrtCollection<AppImport> {
  static readonly _itemClass = AppImport;
}

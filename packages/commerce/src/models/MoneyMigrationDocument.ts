/** Durable, internal rollback journal for one commerce money document. */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export type MoneyMigrationDocumentType = 'invoice' | 'contract';
export type MoneyMigrationDocumentState =
  | 'prepared'
  | 'applied'
  | 'rolled_back';

export interface MoneyMigrationDocumentOptions extends SmrtObjectOptions {
  tenantId?: string;
  migrationId?: string;
  documentType?: MoneyMigrationDocumentType;
  documentId?: string;
  state?: MoneyMigrationDocumentState;
  preImageJson?: string;
  preChecksum?: string;
  postImageJson?: string;
  postChecksum?: string;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'commerce_money_migration_documents',
  conflictColumns: [
    'tenant_id',
    'migration_id',
    'document_type',
    'document_id',
  ],
  sensitive: true,
  api: false,
  mcp: false,
  cli: false,
})
export class MoneyMigrationDocument extends SmrtObject {
  @tenantId()
  tenantId = '';

  @field({ indexed: true })
  migrationId = '';

  @field({ indexed: true })
  documentType: MoneyMigrationDocumentType = 'invoice';

  @field({ indexed: true })
  documentId = '';

  state: MoneyMigrationDocumentState = 'prepared';

  @field({ type: 'text', sensitive: true })
  preImageJson = '';

  preChecksum = '';

  @field({ type: 'text', sensitive: true })
  postImageJson = '';

  postChecksum = '';

  constructor(options: MoneyMigrationDocumentOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.migrationId !== undefined)
      this.migrationId = options.migrationId;
    if (options.documentType !== undefined)
      this.documentType = options.documentType;
    if (options.documentId !== undefined) this.documentId = options.documentId;
    if (options.state !== undefined) this.state = options.state;
    if (options.preImageJson !== undefined)
      this.preImageJson = options.preImageJson;
    if (options.preChecksum !== undefined)
      this.preChecksum = options.preChecksum;
    if (options.postImageJson !== undefined)
      this.postImageJson = options.postImageJson;
    if (options.postChecksum !== undefined)
      this.postChecksum = options.postChecksum;
  }
}

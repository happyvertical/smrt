import { SmrtCollection } from '@happyvertical/smrt-core';
import { MoneyMigrationDocument } from '../models/MoneyMigrationDocument.js';

export class MoneyMigrationDocumentCollection extends SmrtCollection<MoneyMigrationDocument> {
  static readonly _itemClass = MoneyMigrationDocument;

  async findDocument(input: {
    tenantId: string;
    migrationId: string;
    documentType: 'invoice' | 'contract';
    documentId: string;
  }): Promise<MoneyMigrationDocument | null> {
    return (
      (
        await this.list({
          where: input,
          limit: 1,
        })
      )[0] ?? null
    );
  }
}

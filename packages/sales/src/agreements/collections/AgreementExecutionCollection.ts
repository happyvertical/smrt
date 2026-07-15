import { SmrtCollection } from '@happyvertical/smrt-core';
import { AgreementExecution } from '../models/AgreementExecution.js';

export class AgreementExecutionCollection extends SmrtCollection<AgreementExecution> {
  static readonly _itemClass = AgreementExecution;

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<AgreementExecution | null> {
    const rows = await this.list({ where: { idempotencyKey }, limit: 1 });
    return rows[0] ?? null;
  }

  async findByProviderRequest(
    provider: string,
    providerRequestId: string,
  ): Promise<AgreementExecution | null> {
    const rows = await this.list({
      where: { provider, providerRequestId },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  async findBySource(
    sourceKind: string,
    sourceId: string,
  ): Promise<AgreementExecution[]> {
    return await this.list({
      where: { sourceKind, sourceId },
      orderBy: 'source_version DESC',
    });
  }
}

export default AgreementExecutionCollection;

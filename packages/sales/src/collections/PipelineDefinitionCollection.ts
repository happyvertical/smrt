import { SmrtCollection } from '@happyvertical/smrt-core';
import { PipelineDefinition } from '../models/PipelineDefinition.js';

export class PipelineDefinitionCollection extends SmrtCollection<PipelineDefinition> {
  static readonly _itemClass = PipelineDefinition;

  async findByKey(
    key: string,
    tenantId?: string,
  ): Promise<PipelineDefinition | null> {
    const where: Record<string, unknown> = { key };
    if (tenantId !== undefined) {
      where.tenantId = tenantId;
    }
    const rows = await this.list({ where });
    return rows[0] ?? null;
  }

  async getDefault(tenantId?: string): Promise<PipelineDefinition | null> {
    const explicitWhere: Record<string, unknown> = { isDefault: true };
    if (tenantId !== undefined) {
      explicitWhere.tenantId = tenantId;
    }
    const explicit = await this.list({ where: explicitWhere });
    if (explicit[0]) {
      return explicit[0];
    }

    return this.findByKey('default', tenantId);
  }
}

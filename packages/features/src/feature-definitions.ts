import { SmrtCollection } from '@happyvertical/smrt-core';
import { FeatureDefinition } from './feature-definition.js';
import type { FeatureDefinitionSeed } from './types.js';
import { serializeFeatureMetadata } from './utils.js';

export class FeatureDefinitionCollection extends SmrtCollection<FeatureDefinition> {
  static readonly _itemClass = FeatureDefinition;

  async findByFeatureKey(
    featureKey: string,
  ): Promise<FeatureDefinition | null> {
    const results = await this.list({
      where: { featureKey },
      limit: 1,
    });
    return results[0] ?? null;
  }

  async findByPackageName(packageName: string): Promise<FeatureDefinition[]> {
    return this.list({
      where: { packageName },
    });
  }

  async upsertDefinition(seed: FeatureDefinitionSeed): Promise<{
    definition: FeatureDefinition;
    status: 'created' | 'updated' | 'unchanged';
  }> {
    const existing = await this.findByFeatureKey(seed.featureKey);

    if (!existing) {
      const created = await this.create({
        ...seed,
        metadata: serializeFeatureMetadata(seed.metadata),
      });
      await created.save();
      return { definition: created, status: 'created' };
    }

    const nextMetadata = serializeFeatureMetadata(seed.metadata);
    const changed =
      existing.packageName !== seed.packageName ||
      existing.qualifiedClassName !== seed.qualifiedClassName ||
      existing.className !== seed.className ||
      existing.localId !== seed.localId ||
      existing.defaultEnabled !== seed.defaultEnabled ||
      existing.label !== (seed.label ?? '') ||
      existing.description !== (seed.description ?? '') ||
      existing.metadata !== nextMetadata ||
      existing.visibility !== (seed.visibility ?? 'public');

    if (!changed) {
      return { definition: existing, status: 'unchanged' };
    }

    existing.packageName = seed.packageName;
    existing.qualifiedClassName = seed.qualifiedClassName;
    existing.className = seed.className;
    existing.localId = seed.localId;
    existing.defaultEnabled = seed.defaultEnabled;
    existing.label = seed.label ?? '';
    existing.description = seed.description ?? '';
    existing.metadata = nextMetadata;
    existing.visibility = seed.visibility ?? 'public';
    await existing.save();

    return { definition: existing, status: 'updated' };
  }
}

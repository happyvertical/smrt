import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { FeatureDefinitionOptions, FeatureMetadata } from './types.js';
import { parseFeatureMetadata, serializeFeatureMetadata } from './utils.js';

@smrt({
  tableName: '_smrt_feature_definitions',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'], exclude: ['getMetadata', 'setMetadata'] },
  mcp: { include: ['list', 'get'], exclude: ['getMetadata', 'setMetadata'] },
  conflictColumns: ['feature_key'],
})
export class FeatureDefinition extends SmrtObject {
  featureKey: string = '';
  packageName: string = '';
  qualifiedClassName: string = '';
  className: string = '';
  localId: string = '';
  defaultEnabled: boolean = false;
  label: string = '';
  description: string = '';
  metadata: string = '';
  visibility: string = 'public';

  constructor(options: FeatureDefinitionOptions = {}) {
    super(options);

    if (options.featureKey !== undefined) this.featureKey = options.featureKey;
    if (options.packageName !== undefined)
      this.packageName = options.packageName;
    if (options.qualifiedClassName !== undefined) {
      this.qualifiedClassName = options.qualifiedClassName;
    }
    if (options.className !== undefined) this.className = options.className;
    if (options.localId !== undefined) this.localId = options.localId;
    if (options.defaultEnabled !== undefined) {
      this.defaultEnabled = options.defaultEnabled;
    }
    if (options.label !== undefined) this.label = options.label;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.visibility !== undefined) this.visibility = options.visibility;
    if (options.metadata !== undefined) {
      this.metadata = serializeFeatureMetadata(options.metadata);
    }
  }

  getMetadata(): FeatureMetadata {
    return parseFeatureMetadata(this.metadata);
  }

  setMetadata(metadata: FeatureMetadata | null): void {
    this.metadata = serializeFeatureMetadata(metadata);
  }
}

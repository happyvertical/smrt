import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  FeatureOverrideEffect,
  type FeatureOverrideOptions,
  type FeatureScopeType,
  GLOBAL_FEATURE_SCOPE_ID,
} from './types.js';

@smrt({
  tableName: '_smrt_feature_overrides',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: {
    exclude: ['isInherit', 'isEnabled', 'isDisabled'],
  },
  mcp: {
    exclude: ['isInherit', 'isEnabled', 'isDisabled'],
  },
  conflictColumns: ['feature_key', 'scope_type', 'scope_id'],
})
export class FeatureOverride extends SmrtObject {
  featureKey: string = '';
  scopeType: FeatureScopeType = 'global';
  scopeId: string = GLOBAL_FEATURE_SCOPE_ID;
  effect: FeatureOverrideEffect = FeatureOverrideEffect.INHERIT;

  constructor(options: FeatureOverrideOptions = {}) {
    super(options);

    if (options.featureKey !== undefined) this.featureKey = options.featureKey;
    if (options.scopeType !== undefined) this.scopeType = options.scopeType;
    if (options.scopeId !== undefined) this.scopeId = options.scopeId;
    if (options.effect !== undefined) this.effect = options.effect;
  }

  isInherit(): boolean {
    return this.effect === FeatureOverrideEffect.INHERIT;
  }

  isEnabled(): boolean {
    return this.effect === FeatureOverrideEffect.ENABLE;
  }

  isDisabled(): boolean {
    return this.effect === FeatureOverrideEffect.DISABLE;
  }
}

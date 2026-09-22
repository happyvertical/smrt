import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  FeatureOverrideEffect,
  type FeatureOverrideOptions,
  type FeatureScopeType,
  GLOBAL_FEATURE_SCOPE_ID,
} from './types.js';

// Override rows are authorization state: any scope (global, another tenant,
// another user) can be written, and the object is not tenant-scoped. Generated
// REST routes and MCP tools only check authentication, so they are closed
// (#3013). Hosts write overrides server-side through
// `FeatureOverrideCollection.setOverride()` / `removeOverride()` after their
// own authorization decision. The CLI is closed too: generated CLI commands
// dispatch through the generated API.
@smrt({
  tableName: '_smrt_feature_overrides',
  api: false,
  cli: false,
  mcp: false,
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

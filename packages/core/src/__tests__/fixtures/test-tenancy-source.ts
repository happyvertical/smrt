/**
 * A tenancy policy source for core tests (#5375).
 *
 * Request paths resolve each model's tenancy from the source smrt-tenancy
 * installs in `enableTenancy()`; with tenancy enabled and no source, every
 * scoped decision refuses. Core cannot import smrt-tenancy, so tests that
 * simulate enabled tenancy (`setDispatchTenantResolver`) install this source:
 * a model's declared `tenantScoped` config, plus classes a test marks as
 * tenant-scoped at run time.
 */

import { ObjectRegistry } from '../../registry.js';
import {
  setTenantPolicySource,
  type TenantPolicyConfig,
} from '../../request-tenancy.js';

let runtimeScoped: ((key: string) => boolean) | undefined;

/**
 * Mark classes tenant-scoped at run time (optional mode, `tenantId`), as a
 * `registerTenantScopedClass()` call would; `undefined` clears the marks.
 */
export function setTestRuntimeTenancy(
  predicate: ((key: string) => boolean) | undefined,
): void {
  runtimeScoped = predicate;
}

function declaredPolicy(key: string): TenantPolicyConfig | undefined {
  const declared = ObjectRegistry.getTenantScopedConfig(key);
  if (!declared) return undefined;
  return {
    mode: declared.mode,
    field: declared.field,
    allowSuperAdminBypass: declared.allowSuperAdminBypass === true,
  };
}

/** Install the test policy source (it decides only while tenancy is on). */
export function installTestTenancySource(): void {
  setTenantPolicySource({
    policyOf: (key) => {
      if (runtimeScoped?.(key)) {
        return {
          kind: 'resolved',
          policy: {
            mode: 'optional',
            field: 'tenantId',
            allowSuperAdminBypass: false,
          },
        };
      }
      const policy = declaredPolicy(key);
      return policy ? { kind: 'resolved', policy } : { kind: 'absent' };
    },
    systemContextActive: () => false,
    superAdminBypassActive: () => false,
    hierarchyReadCollections: () => undefined,
    runInContext: (_context, fn) => fn(),
  });
}

/** Remove the test policy source and the run-time marks. */
export function removeTestTenancySource(): void {
  runtimeScoped = undefined;
  setTenantPolicySource(undefined);
}

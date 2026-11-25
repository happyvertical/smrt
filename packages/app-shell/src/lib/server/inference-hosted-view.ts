// The inference settings page an owner sees in the cloud profile (#5191).
//
// The shared controller's `load` shows the deployment's own rows beside the
// caller's: the operator's tier targets, aliases (candidate models, base URLs,
// the names of key variables), fusions (seat prompts) and the app-wide
// transcript setting. An owner owns one tenant, not the deployment, and writes
// to those rows are already refused (`tenantOnlyInCloud`); the owner's interim
// decision is that they are not shown either. This keeps what is the tenant's
// own (its tier overrides, default tier, key state, usage) and removes the
// rest, here, because the controller is shared with hosts where the owner IS
// the deployment.
import type { InferenceSettingsPageData } from '@happyvertical/smrt-inference/server';

/** What an owner who does not own the deployment may see of the settings page. */
export function hideDeploymentRows(
  data: InferenceSettingsPageData,
): InferenceSettingsPageData {
  return {
    ...data,
    // Only the tenant's own override stays; what the operator set (the app
    // target, what the tier falls back to, where its value comes from) goes.
    tiers: data.tiers.map((row) => {
      const own = row.supplyingLevel === 'tenant' || row.tenantTarget != null;
      return {
        tier: row.tier,
        effectiveLabel: own ? row.effectiveLabel : 'Provided by the platform',
        effectiveTarget: own ? row.effectiveTarget : null,
        supplyingLevel: own ? row.supplyingLevel : undefined,
        tenantTarget: row.tenantTarget ?? null,
        appTarget: null,
        inheritedLabel: null,
      };
    }),
    defaultTier: data.defaultTier
      ? {
          effectiveTier: data.defaultTier.effectiveTier,
          tenantTier: data.defaultTier.tenantTier ?? null,
          appTier: null,
          inheritedTier: null,
        }
      : data.defaultTier,
    aliases: [],
    fusions: [],
    transcripts: null,
  } as unknown as InferenceSettingsPageData;
}

/**
 * Standard paid feature keys for the tier ladder (#4761, epic #4667).
 *
 * Gates reference these constants, never string literals. They are framework
 * feature definitions (see `framework-features.ts`): dotted keys, not
 * `<qualifiedClassName>#<localId>`, because a subscription plan grants them by
 * the same string (`SubscriptionPlan.features[].featureKey`). Every standard
 * key is `paid: true` and defaults off, so it is enabled only by a plan grant
 * or an explicit override.
 *
 * Keys are persisted identifiers (plan grants and override rows store the
 * string): never rename one.
 */
import type { FrameworkFeatureDefinition } from './framework-features.js';

/** Multi-device sync (#4668/#4670). */
export const FEATURE_SYNC_DEVICES = 'sync.devices';
/** Encrypted cloud backup of the vault. */
export const FEATURE_BACKUP_VAULT = 'backup.vault';
/** Hosted cloud deployment of the app. */
export const FEATURE_CLOUD_HOSTED = 'cloud.hosted';
/** Hosted (platform-paid) AI inference (#4759, #4760). */
export const FEATURE_INFERENCE_HOSTED = 'inference.hosted';
/** Remotely installed plugins. */
export const FEATURE_PLUGINS_REMOTE = 'plugins.remote';

/** The standard keys by name, for iteration and typed lookups. */
export const STANDARD_FEATURE_KEYS = {
  syncDevices: FEATURE_SYNC_DEVICES,
  backupVault: FEATURE_BACKUP_VAULT,
  cloudHosted: FEATURE_CLOUD_HOSTED,
  inferenceHosted: FEATURE_INFERENCE_HOSTED,
  pluginsRemote: FEATURE_PLUGINS_REMOTE,
} as const;

export type StandardFeatureKey =
  (typeof STANDARD_FEATURE_KEYS)[keyof typeof STANDARD_FEATURE_KEYS];

const OWNER = '@happyvertical/smrt-features';

/** Definitions of the standard keys; all `paid: true`, all default off. */
export const STANDARD_FEATURES: readonly FrameworkFeatureDefinition[] =
  Object.freeze(
    (
      [
        {
          featureKey: FEATURE_SYNC_DEVICES,
          packageName: OWNER,
          label: 'Device sync',
          description: 'Sync data between a member’s devices.',
          defaultEnabled: false,
          metadata: { paid: true },
        },
        {
          featureKey: FEATURE_BACKUP_VAULT,
          packageName: OWNER,
          label: 'Vault backup',
          description: 'Keep an encrypted cloud backup of the vault.',
          defaultEnabled: false,
          metadata: { paid: true },
        },
        {
          featureKey: FEATURE_CLOUD_HOSTED,
          packageName: OWNER,
          label: 'Cloud hosting',
          description: 'Run the app on hosted cloud infrastructure.',
          defaultEnabled: false,
          metadata: { paid: true },
        },
        {
          featureKey: FEATURE_INFERENCE_HOSTED,
          packageName: OWNER,
          label: 'Hosted AI',
          description:
            'Use platform-hosted AI inference instead of a member’s own provider key.',
          defaultEnabled: false,
          metadata: { paid: true },
        },
        {
          featureKey: FEATURE_PLUGINS_REMOTE,
          packageName: OWNER,
          label: 'Remote plugins',
          description: 'Install plugins from a remote catalog.',
          defaultEnabled: false,
          metadata: { paid: true },
        },
      ] satisfies FrameworkFeatureDefinition[]
    ).map((definition) =>
      Object.freeze({
        ...definition,
        metadata: Object.freeze({ ...definition.metadata }),
      }),
    ),
  );

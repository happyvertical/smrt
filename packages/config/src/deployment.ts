/**
 * `@happyvertical/smrt-config/deployment`: the compose deployment contract.
 *
 * A Compose file annotated with `x-happyvertical` extension fields declares
 * how an application is deployed. This entry validates that declaration,
 * resolves it into plain data, and renders it for the `smrt-app` chart or as a
 * `HostedApp` for a hosting platform. It is browser-safe and separate from the
 * configuration loader; the network half is `./deployment/hosting`.
 */

export {
  renderSmrtAppChartValues,
  SMRT_RELEASE_GUARD,
  type SmrtAppChartInputs,
  type SmrtAppChartProbeTiming,
  type SmrtAppChartResources,
  type SmrtAppChartSecretEnv,
  type SmrtAppChartSecretRef,
  SmrtAppChartValuesError,
  type SmrtAppChartWorkerRole,
  type SmrtAppChartWorkloadInputs,
} from './deployment/chart-values.js';
export {
  type ComposeDeploymentBinding,
  type ComposeDeploymentDeclaration,
  type ComposeDeploymentHealth,
  type ComposeDeploymentIssue,
  type ComposeDeploymentIssueCode,
  type ComposeDeploymentMigration,
  type ComposeDeploymentOptions,
  type ComposeDeploymentResult,
  type ComposeDeploymentStage,
  type ComposeDeploymentVolume,
  type ComposeDeploymentWorkload,
  formatComposeDeploymentReport,
  validateComposeDeployment,
  X_HAPPYVERTICAL_BINDINGS,
  X_HAPPYVERTICAL_KEY,
  X_HAPPYVERTICAL_PRESETS,
  X_HAPPYVERTICAL_ROLES,
  X_HAPPYVERTICAL_SCHEMA_ID,
  X_HAPPYVERTICAL_VERSION,
  type XHappyVerticalBinding,
  type XHappyVerticalPreset,
  type XHappyVerticalRole,
} from './deployment/compose-contract.js';
export {
  type ComposeHostedAppInput,
  type ComposeHostedAppResult,
  composeHostedApp,
  HOSTED_APP_API_VERSION,
  HOSTED_APP_KIND,
  HOSTED_APP_NAME_MAX_LENGTH,
  HOSTED_APP_PRESET,
  HOSTED_APP_TIERS,
  HOSTED_APP_WORKER_ROLES,
  type HostedAppEntitlements,
  type HostedAppManifest,
  type HostedAppPlacement,
  type HostedAppPresetOptions,
  type HostedAppRejection,
  type HostedAppTier,
  type HostedAppWorkerRole,
  hostedAppReleaseId,
  isHostedAppCommit,
} from './deployment/hosted-app.js';

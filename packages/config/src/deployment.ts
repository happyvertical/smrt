/**
 * `@happyvertical/smrt-config/deployment`: the compose deployment contract.
 *
 * A Compose file annotated with `x-happyvertical` extension fields declares
 * how an application is deployed. This entry validates that declaration,
 * resolves it into plain data, and renders it for the `smrt-app` chart. It is
 * browser-safe and separate from the configuration loader.
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

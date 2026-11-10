export {
  provisionRestartAccount,
  supersedeVaultAccount,
  unsupersedeVaultAccount,
} from './actions.js';
export {
  NOT_OWNER_CODE,
  NotOwnerError,
  StepUpRequiredError,
  VaultAccountAdminError,
} from './errors.js';
export {
  createVaultRelayAdminClient,
  type VaultRelayAdminClientOptions,
} from './relay-admin-client.js';
export type {
  ProvisionRestartAccountInput,
  ProvisionRestartAccountResult,
  SupersedeVaultAccountInput,
  UnsupersedeVaultAccountInput,
  VaultAccountAction,
  VaultAccountAdminDeps,
  VaultAccountAuditEntry,
  VaultAccountAuditSink,
  VaultAccountDenial,
  VaultAccountDirectory,
  VaultRelayAdminPort,
} from './types.js';

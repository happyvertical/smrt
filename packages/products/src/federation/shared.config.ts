/**
 * Federation Shared Dependencies Configuration
 *
 * Centralized configuration for shared dependencies to prevent duplication
 * and ensure compatibility across federated modules.
 */

export interface SharedDependency {
  singleton?: boolean;
  requiredVersion?: string;
  strictVersion?: boolean;
  eager?: boolean;
}

export const sharedDependencies: Record<string, SharedDependency> = {
  // Core framework dependencies
  svelte: {
    singleton: true,
    requiredVersion: '^5.0.0',
    eager: true,
  },

  // SMRT framework
  '@have/smrt': {
    singleton: true,
    requiredVersion: 'workspace:*',
    eager: true,
  },

  // Common utilities (add as needed)
  // 'lodash': {
  //   singleton: true,
  //   requiredVersion: '^4.17.0'
  // },
  //
  // 'date-fns': {
  //   singleton: true,
  //   requiredVersion: '^2.29.0'
  // },
  //
  // 'uuid': {
  //   singleton: true,
  //   requiredVersion: '^9.0.0'
  // }
};

export default sharedDependencies;

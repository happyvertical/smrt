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

  // NOTE: do not add SMRT framework packages here as federation `shared`
  // entries unless this remote actually imports them as a bare specifier.
  // A previous `@smrt/core` entry (with a `workspace:*` requiredVersion)
  // broke the federation build: @originjs/vite-plugin-federation treats every
  // shared key as an entry module to resolve, and `@smrt/core` is not a real
  // importable package (the framework package is `@happyvertical/smrt-core`,
  // and nothing in the federated surface imports it).

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

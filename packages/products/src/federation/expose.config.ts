/**
 * Federation Expose Configuration
 *
 * Defines what components, features, and applications this SMRT service
 * exposes for consumption by other applications via module federation.
 */

export interface ExposeConfig {
  // Component level exports
  components: Record<string, string>;

  // Feature module exports
  features: Record<string, string>;

  // Complete application exports
  applications: Record<string, string>;

  // Model and store exports
  logic: Record<string, string>;

  // Auto-generated SMRT components
  generated: Record<string, string>;
}

export const exposeConfig: ExposeConfig = {
  // Individual UI Components (most granular) - testing with minimal component first
  components: {
    './TestComponent': './src/lib/components/TestComponent.svelte',
  },

  // Feature Modules (medium granularity)
  features: {
    // All disabled for testing
  },

  // Complete Applications/Pages (coarse granularity)
  applications: {
    // Applications disabled - they depend on server-side features
  },

  // Business Logic (browser-compatible only)
  logic: {
    // Stores disabled - consumers should implement their own data layer
  },

  // Auto-generated SMRT Components (will be populated when available)
  generated: {
    // Auto-generated components disabled for federation
  },
};

// Flatten all exports for federation config
export const flattenedExposes = {
  ...exposeConfig.components,
  ...exposeConfig.features,
  ...exposeConfig.applications,
  ...exposeConfig.logic,
  ...exposeConfig.generated,
};

export default exposeConfig;

/**
 * Federation Consume Configuration
 *
 * Defines what external federated modules this SMRT service consumes.
 * This allows the service to use components and features from other microservices.
 */

export interface ConsumeConfig {
  // Remote services this application consumes from
  remotes: Record<string, string>;

  // Shared dependencies configuration
  shared: Record<string, any>;
}

export const consumeConfig: ConsumeConfig = {
  // External federated services to consume from
  remotes: {
    // Example: Foundation service providing base UI components
    // foundation: 'http://localhost:3000/assets/remoteEntry.js',
    // Example: Auth service providing authentication components
    // authService: 'http://localhost:3003/assets/remoteEntry.js',
    // Example: Notification service
    // notificationService: 'http://localhost:3004/assets/remoteEntry.js'
  },

  // Shared dependencies to prevent duplication
  shared: {
    svelte: {
      singleton: true,
      requiredVersion: '^5.0.0',
    },
    '@have/smrt': {
      singleton: true,
      requiredVersion: 'workspace:*',
    },
    // Add other shared libraries as needed:
    // 'lodash': { singleton: true },
    // 'date-fns': { singleton: true }
  },
};

export default consumeConfig;

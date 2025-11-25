/**
 * SMRT Configuration
 *
 * This file configures the SMRT framework for your project.
 * See: https://github.com/happyvertical/smrt
 */

export default {
  // Global SMRT settings
  smrt: {
    logLevel: 'info',
    schemaMigration: {
      strategy: 'auto-add',
    },
  },

  // Package-specific configuration
  packages: {
    // CLI configuration
    cli: {
      database: {
        type: 'sqlite',
        url: process.env.DATABASE_URL || './data/app.db',
      },
      verbose: false,
    },

    // AI configuration (optional)
    ai: process.env.OPENAI_API_KEY
      ? {
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY,
        }
      : undefined,
  },
};

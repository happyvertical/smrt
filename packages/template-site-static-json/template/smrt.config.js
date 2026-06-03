/**
 * SMRT Configuration for {{SITE_NAME}}
 *
 * This file configures site identity, navigation, data sources, and workflows.
 */

export default {
  // Site identity (used by components for titles, navigation, SEO)
  site: {
    name: '{{SITE_NAME}}',
    shortName: '{{SITE_SHORT_NAME}}',
    description: 'Local news and community information for {{LOCATION_NAME}}',
    url: 'https://{{PACKAGE_NAME}}.com',
    location: {
      name: '{{LOCATION_NAME}}',
      latitude: {{LATITUDE}},
      longitude: {{LONGITUDE}},
      timezone: '{{TIMEZONE}}',
    },
    navigation: {
      primary: [
        { label: 'Politics', href: '/politics' },
        { label: 'Weather', href: '/weather' },
      ],
      footer: [
        { label: 'About', href: '/about' },
        { label: 'Contact', href: '/contact' },
        { label: 'RSS', href: '/rss.xml' },
      ],
    },
    theme: {
      primaryColor: '#1976d2',
      primaryLight: '#e3f2fd',
      primaryDark: '#0d47a1',
    },
  },

  // Site-wide category definitions (for routing/navigation)
  categories: {
    politics: {
      name: 'Politics',
      children: {
        local: { name: 'Local Government' },
        county: { name: 'County Government' },
      },
    },
    community: {
      name: 'Community',
      children: {
        events: { name: 'Events' },
      },
    },
  },

  // Agent/developer knowledge defaults
  knowledge: {
    enabled: true,
    cli: true,
    mcp: true,
    api: {
      enabled: false,
      basePath: '/__smrt/knowledge',
      requireAdmin: true,
      includeDocs: false,
      includePrompts: false,
    },
  },

  // Global package settings
  packages: {
    cli: {
      verbose: true,
      database: {
        type: 'json',
        url: './data',
      },
    },
    ai: {
      defaultProvider: 'claude-cli',
      defaultModel: 'sonnet',
    },
  },

  // Module-specific configurations
  modules: {
    // Praeco module configuration (meeting scraper)
    praeco: {
      db: {
        type: 'json',
        url: './data',
        writeStrategy: 'immediate',
      },
      ai: {
        type: 'gemini',
        model: 'gemini-2.0-flash-exp',
        apiKey: process.env.GEMINI_API_KEY,
      },
      analyzeOptions: {
        detailLevel: 'comprehensive',
      },
      // Add your council sources here
      sources: [
        // Example:
        // {
        //   type: 'documents',
        //   council: 'my-council',
        //   url: 'https://example.com/meetings/',
        // },
      ],
      // Add your report configurations here
      reports: [
        // Example:
        // {
        //   type: 'meeting-recap',
        //   council: 'my-council',
        //   category: 'politics/local',
        //   author: '{{SITE_SHORT_NAME}} Reporter',
        //   role: 'You are a professional journalist writing for {{LOCATION_NAME}} residents.',
        // },
      ],
    },

    // Caelus module configuration (weather)
    caelus: {
      db: {
        type: 'json',
        url: './data',
        writeStrategy: 'immediate',
        clearCache: true,
      },
      provider: 'environment-canada',
      location: {
        name: '{{LOCATION_NAME}}',
        latitude: {{LATITUDE}},
        longitude: {{LONGITUDE}},
      },
      logLevel: 'info',
    },
  },
};

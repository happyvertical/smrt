# @have/agents Specification

## 1. Overview

This document outlines the specification for the `@have/agents` module. The goal is to create a framework for building agents that operate within the `@have/smrt` ecosystem. This module will provide a base `Agent` class that other agents can extend, abstracting away common functionalities and providing a consistent structure for agent development.

## 2. Core Concepts

### 2.1. Agent

An `Agent` is a `SmrtObject` that is designed to perform a specific set of tasks. Agents are configurable, observable, and can be run as a service. They are the primary actors in the `@have/smrt` ecosystem, responsible for orchestrating the various modules and libraries to achieve a specific goal. By extending `SmrtObject`, each agent instance is a persistent object in the database, allowing it to maintain state and have a memory.

### 2.2. Configuration

Agents use the `@have/config` module for configuration management. Each agent's configuration is loaded from `smrt.config.js` (or other supported formats) under the `modules` key. Configuration is hierarchical and can be overridden by environment variables.

## 3. The `Agent` Class

The `Agent` class will be a `SmrtObject` with the following features:

### 3.1. Configuration Loading

Agents load their configuration using `getModuleConfig()` from `@have/config`:

```typescript
import { getModuleConfig } from '@have/config';

@smrt()
export class MyAgent extends Agent {
  private config = getModuleConfig('my-agent', {
    // Default values
    cronSchedule: '0 0 * * *',
    maxRetries: 3,
  });
}
```

Configuration is defined in `smrt.config.js`:

```javascript
export default {
  modules: {
    'my-agent': {
      cronSchedule: '0 2 * * *',
      maxRetries: 5,
    },
  },
};
```

### 3.2. Status Tracking

The `Agent` class will track its execution status:

```typescript
status: 'idle' | 'initializing' | 'running' | 'error' | 'shutdown'
```

This allows monitoring and prevents duplicate runs.

### 3.3. Logging

The `Agent` class will have a pre-configured logger from the `@have/logger` module. This will provide a standardized way to log messages and errors.

### 3.4. Lifecycle Methods

The `Agent` class will have a set of lifecycle methods that can be overridden by the extending agent:

- `initialize()`: Called after the agent has been constructed and the configuration has been loaded. Sets status to 'initializing'.
- `validate()`: Called before `run()` to validate configuration and dependencies. Throws if validation fails. This prevents runtime errors from misconfiguration.
- `run()`: The main entry point for the agent's logic. Sets status to 'running'. Updates `lastRun` metadata on completion.
- `shutdown()`: Called when the agent is shutting down (e.g., SIGTERM), allowing for graceful cleanup. Sets status to 'shutdown'.

## 4. Agent Class Structure

```typescript
import { SmrtObject, smrt } from '@have/smrt';
import { getModuleConfig } from '@have/config';
import { createLogger } from '@have/logger';

export type AgentStatusType = 'idle' | 'initializing' | 'running' | 'error' | 'shutdown';

export abstract class Agent extends SmrtObject {
  // Status tracking
  status: AgentStatusType = 'idle';

  // Logger
  protected logger = createLogger({ level: 'info' });

  // Configuration (loaded by extending class)
  protected abstract config: unknown;

  /**
   * Initialize the agent
   * Override to perform setup after construction, but always call super.initialize()
   */
  async initialize(): Promise<this> {
    await super.initialize();
    this.status = 'initializing';
    this.logger.info('Agent initializing');

    // Setup signal handlers for graceful shutdown
    this.setupSignalHandlers();

    return this;
  }

  /**
   * Validate configuration and dependencies
   * Override to check agent-specific requirements
   * @throws Error if validation fails
   */
  async validate(): Promise<void> {
    this.logger.info('Validating agent configuration');
    // Base implementation - extending agents should override
  }

  /**
   * Main agent logic
   * Must be implemented by extending class
   */
  abstract run(): Promise<void>;

  /**
   * Cleanup and shutdown
   * Override to perform graceful shutdown
   * Always call super.shutdown() to clean up signal handlers
   */
  async shutdown(): Promise<void> {
    this.status = 'shutdown';
    this.logger.info('Agent shutting down');
    this.cleanupSignalHandlers();
  }

  /**
   * Execute agent with lifecycle management
   */
  async execute(): Promise<void> {
    try {
      await this.initialize();
      await this.validate();

      this.status = 'running';
      await this.run();
      this.status = 'idle';

      this.logger.info('Agent execution completed');
    } catch (error) {
      this.status = 'error';
      this.logger.error('Agent execution failed', { error });
      throw error;
    }
  }

  /**
   * Set up signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    // Implementation details...
  }

  /**
   * Clean up signal handlers
   */
  private cleanupSignalHandlers(): void {
    // Implementation details...
  }
}
```

## 5. Use Case: Praeco

`Praeco` will be refactored to be an `Agent`. It will extend the `Agent` class and implement the `run()` method to perform its crawling and processing logic.

### Example Implementation

```typescript
import { Agent } from '@have/agents';
import { getModuleConfig } from '@have/config';
import { smrt } from '@have/smrt';

interface PraecoConfig {
  sources: string[];
  cronSchedule: string;
  maxArticlesPerRun: number;
}

@smrt()
export class Praeco extends Agent {
  protected config = getModuleConfig<PraecoConfig>('praeco', {
    sources: [],
    cronSchedule: '0 2 * * *',
    maxArticlesPerRun: 50,
  });

  // Agents can define their own state properties
  // These will be automatically persisted by SmrtObject
  lastCrawl: Record<string, Date> = {};
  articlesSeen: string[] = [];
  articlesProcessed: number = 0;

  async validate(): Promise<void> {
    if (!this.config.sources || this.config.sources.length === 0) {
      throw new Error('Praeco requires at least one source URL');
    }

    for (const source of this.config.sources) {
      try {
        new URL(source);
      } catch {
        throw new Error(`Invalid source URL: ${source}`);
      }
    }
  }

  async run(): Promise<void> {
    this.logger.info(`Starting Praeco crawl of ${this.config.sources.length} sources`);

    let processed = 0;

    for (const source of this.config.sources) {
      this.logger.info(`Crawling ${source}`);

      const articles = await this.crawlSource(source);

      // Filter out already-seen articles
      const newArticles = articles.filter(
        article => !this.articlesSeen.includes(article.url)
      );

      this.logger.info(`Found ${newArticles.length} new articles from ${source}`);

      // Process articles...
      for (const article of newArticles) {
        await this.processArticle(article);
        this.articlesSeen.push(article.url);
        processed++;

        if (processed >= this.config.maxArticlesPerRun) {
          this.logger.info('Reached max articles limit');
          break;
        }
      }

      // Update last crawl time
      this.lastCrawl[source] = new Date();

      if (processed >= this.config.maxArticlesPerRun) {
        break;
      }
    }

    this.articlesProcessed = processed;
    this.logger.info(`Praeco completed: ${processed} articles processed`);

    // Save state (extends SmrtObject, so properties are persisted)
    await this.save();
  }

  private async crawlSource(source: string) {
    // Implementation...
    return [];
  }

  private async processArticle(article: any) {
    // Implementation...
  }
}
```

### Configuration

```javascript
// smrt.config.js
export default {
  modules: {
    praeco: {
      sources: [
        'https://example.com/city-council/meetings',
        'https://example.com/planning-board/agendas',
      ],
      cronSchedule: '0 2 * * *', // 2 AM daily
      maxArticlesPerRun: 100,
    },
  },
};
```
---
id: "agents"
title: "@smrt/agents: Autonomous Agent Framework"
sidebar_label: "@smrt/agents"
sidebar_position: 4
---

# @smrt/agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Agent framework for building autonomous actors in the SMRT ecosystem.

## Overview

The `@smrt/agents` package provides a base `Agent` class for building autonomous actors that perform specific tasks with full lifecycle management, status tracking, and database persistence. Agents extend `SmrtObject`, inheriting all SMRT framework capabilities including automatic database persistence, AI-powered methods, and code generation.

Agents are designed for long-running processes, scheduled tasks, and autonomous operations that require state management, graceful shutdown, and structured logging. Each agent manages its own lifecycle with configurable hooks for initialization, validation, execution, and shutdown.

## Features

- **Lifecycle Management**: Initialize, validate, run, and shutdown hooks with automatic orchestration
- **Status Tracking**: Built-in status management (idle, initializing, running, error, shutdown)
- **Database Persistence**: All agent state automatically persisted via SmrtObject inheritance
- **Structured Logging**: Integrated logger with contextual information via `@have/logger`
- **Graceful Shutdown**: Automatic signal handling (SIGTERM, SIGINT) for clean termination
- **Configuration Management**: Abstract config property for agent-specific settings
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Error Handling**: Status-aware error tracking with structured logging

## Installation

```bash
# Install with pnpm (recommended for monorepo)
pnpm add @smrt/agents

# Or with npm
npm install @smrt/agents

# Or with bun
bun add @smrt/agents
```

## Usage

### Basic Agent

```typescript
import { Agent } from '@smrt/agents';
import { smrt } from '@smrt/core';

@smrt()
class HelloAgent extends Agent {
  protected config = {
    greeting: 'Hello, World!'
  };

  async run(): Promise<void> {
    this.logger.info(this.config.greeting);
  }
}

const agent = new HelloAgent({ name: 'hello-agent' });
await agent.execute();
```

### Scheduled Data Processing Agent

```typescript
import { Agent } from '@smrt/agents';
import { smrt, text, integer, datetime } from '@smrt/core';

@smrt()
class DataProcessorAgent extends Agent {
  protected config = {
    cronSchedule: '0 2 * * *', // Daily at 2 AM
    batchSize: 100,
    maxRetries: 3
  };

  // Agent state - automatically persisted to database
  @text()
  lastProcessedId?: string;

  @integer()
  totalProcessed: number = 0;

  @datetime()
  lastRun?: Date;

  async validate(): Promise<void> {
    if (!this.config.cronSchedule) {
      throw new Error('cronSchedule is required');
    }
    if (this.config.batchSize <= 0) {
      throw new Error('batchSize must be positive');
    }
  }

  async run(): Promise<void> {
    this.logger.info('Starting data processing', {
      batchSize: this.config.batchSize,
      lastProcessedId: this.lastProcessedId
    });

    let processed = 0;
    const items = await this.fetchDataBatch();

    for (const item of items) {
      try {
        await this.processItem(item);
        this.lastProcessedId = item.id;
        processed++;
      } catch (error) {
        this.logger.error('Failed to process item', { item, error });
      }
    }

    this.totalProcessed += processed;
    this.lastRun = new Date();
    await this.save(); // Persist state

    this.logger.info('Processing complete', {
      processed,
      totalProcessed: this.totalProcessed
    });
  }

  private async fetchDataBatch(): Promise<any[]> {
    // Fetch data from API, database, etc.
    return [];
  }

  private async processItem(item: any): Promise<void> {
    // Process individual item
  }
}

const agent = new DataProcessorAgent({ name: 'data-processor' });
await agent.execute();
```

### Web Scraping Agent

```typescript
import { Agent } from '@smrt/agents';
import { smrt, text, integer, datetime, json } from '@smrt/core';

@smrt()
class ScraperAgent extends Agent {
  protected config = {
    targetUrl: 'https://example.com',
    userAgent: 'Mozilla/5.0...',
    requestDelay: 1000,
    maxPages: 50
  };

  @text()
  lastCrawledUrl?: string;

  @integer()
  pagesProcessed: number = 0;

  @datetime()
  lastCrawl?: Date;

  @json()
  errorLog: Array<{ url: string; error: string; timestamp: Date }> = [];

  async initialize(): Promise<this> {
    await super.initialize();
    this.logger.info('Initializing web scraper', {
      targetUrl: this.config.targetUrl
    });
    return this;
  }

  async validate(): Promise<void> {
    if (!this.config.targetUrl) {
      throw new Error('targetUrl is required');
    }

    // Validate URL format
    try {
      new URL(this.config.targetUrl);
    } catch (error) {
      throw new Error(`Invalid targetUrl: ${this.config.targetUrl}`);
    }
  }

  async run(): Promise<void> {
    const urlsToProcess = await this.discoverUrls();

    for (const url of urlsToProcess.slice(0, this.config.maxPages)) {
      try {
        await this.scrapeUrl(url);
        this.lastCrawledUrl = url;
        this.pagesProcessed++;

        // Respect rate limits
        await this.delay(this.config.requestDelay);
      } catch (error) {
        this.errorLog.push({
          url,
          error: error.message,
          timestamp: new Date()
        });
        this.logger.error('Scraping failed', { url, error });
      }
    }

    this.lastCrawl = new Date();
    await this.save();

    this.logger.info('Scraping complete', {
      pagesProcessed: this.pagesProcessed,
      errors: this.errorLog.length
    });
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down scraper', {
      pagesProcessed: this.pagesProcessed
    });
    // Close browser, cleanup resources, etc.
    await super.shutdown();
  }

  private async discoverUrls(): Promise<string[]> {
    // Discover URLs to scrape
    return [this.config.targetUrl];
  }

  private async scrapeUrl(url: string): Promise<void> {
    // Scrape and process URL
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const agent = new ScraperAgent({ name: 'web-scraper' });
await agent.execute();
```

### Agent with Custom Shutdown Logic

```typescript
import { Agent } from '@smrt/agents';
import { smrt, text } from '@smrt/core';

@smrt()
class DatabaseSyncAgent extends Agent {
  protected config = {
    connectionString: 'postgresql://...',
    syncInterval: 60000
  };

  @text()
  lastSyncId?: string;

  private connection: any;
  private syncTimer: NodeJS.Timeout | null = null;

  async initialize(): Promise<this> {
    await super.initialize();

    // Establish database connection
    this.connection = await this.connectToDatabase();
    this.logger.info('Database connection established');

    return this;
  }

  async validate(): Promise<void> {
    if (!this.config.connectionString) {
      throw new Error('connectionString is required');
    }
    if (!this.connection) {
      throw new Error('Database connection not established');
    }
  }

  async run(): Promise<void> {
    // Set up periodic sync
    this.syncTimer = setInterval(async () => {
      await this.performSync();
    }, this.config.syncInterval);

    // Perform initial sync
    await this.performSync();
  }

  async shutdown(): Promise<void> {
    this.logger.info('Stopping sync timer');

    // Clear sync timer
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    // Close database connection
    if (this.connection) {
      await this.connection.close();
      this.logger.info('Database connection closed');
    }

    await super.shutdown();
  }

  private async connectToDatabase(): Promise<any> {
    // Connect to database
    return { close: async () => {} };
  }

  private async performSync(): Promise<void> {
    this.logger.info('Performing database sync');
    // Sync logic
    await this.save();
  }
}

const agent = new DatabaseSyncAgent({ name: 'db-sync' });
await agent.execute();
```

### Error Handling and Recovery

```typescript
import { Agent } from '@smrt/agents';
import { smrt, integer, datetime } from '@smrt/core';

@smrt()
class ResilientAgent extends Agent {
  protected config = {
    maxRetries: 3,
    retryDelay: 5000
  };

  @integer()
  attemptCount: number = 0;

  @integer()
  successCount: number = 0;

  @integer()
  failureCount: number = 0;

  @datetime()
  lastSuccess?: Date;

  async run(): Promise<void> {
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        this.attemptCount++;
        await this.performWork();

        this.successCount++;
        this.lastSuccess = new Date();
        await this.save();

        this.logger.info('Work completed successfully');
        return;
      } catch (error) {
        this.failureCount++;
        this.logger.error(`Attempt ${attempt + 1} failed`, { error });

        if (attempt < this.config.maxRetries - 1) {
          this.logger.info(`Retrying in ${this.config.retryDelay}ms`);
          await this.delay(this.config.retryDelay);
        } else {
          await this.save();
          throw new Error(
            `All ${this.config.maxRetries} attempts failed: ${error.message}`
          );
        }
      }
    }
  }

  private async performWork(): Promise<void> {
    // Potentially failing work
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const agent = new ResilientAgent({ name: 'resilient-agent' });

try {
  await agent.execute();
} catch (error) {
  console.error('Agent failed after all retries:', error);
  // Handle permanent failure (alert, log to monitoring, etc.)
}
```

### Agent Collections

```typescript
import { Agent } from '@smrt/agents';
import { SmrtCollection } from '@smrt/core';

// Define agent collection for managing multiple agent instances
class AgentCollection extends SmrtCollection<Agent> {
  async getActiveAgents(): Promise<Agent[]> {
    return this.filter(agent => agent.status === 'running');
  }

  async getIdleAgents(): Promise<Agent[]> {
    return this.filter(agent => agent.status === 'idle');
  }

  async getErroredAgents(): Promise<Agent[]> {
    return this.filter(agent => agent.status === 'error');
  }
}

// Run multiple agents
const agents = new AgentCollection();
await agents.load([
  new DataProcessorAgent({ name: 'processor-1' }),
  new ScraperAgent({ name: 'scraper-1' }),
  new DatabaseSyncAgent({ name: 'sync-1' })
]);

// Execute all agents
for (const agent of agents.items) {
  await agent.execute();
}

// Check status
const activeAgents = await agents.getActiveAgents();
console.log(`Active agents: ${activeAgents.length}`);
```

## API Reference

### Agent Class

**Abstract Methods:**
- `run(): Promise<void>` - Main agent logic (must be implemented)

**Lifecycle Methods:**
- `initialize(): Promise<this>` - Setup and initialization
- `validate(): Promise<void>` - Configuration validation
- `execute(): Promise<void>` - Full lifecycle execution
- `shutdown(): Promise<void>` - Cleanup and graceful shutdown

**Properties:**
- `status: AgentStatusType` - Current agent status
- `logger: Logger` - Structured logger instance
- `config: unknown` - Agent configuration (must be defined by subclass)

**Status Types:**
- `'idle'` - Agent is not running
- `'initializing'` - Agent is initializing
- `'running'` - Agent is executing
- `'error'` - Agent encountered an error
- `'shutdown'` - Agent is shutting down

For complete API documentation, see `/api/agents/globals`.

## License

This package is part of the SMRT Framework and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.

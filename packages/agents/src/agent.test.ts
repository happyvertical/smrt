import { ObjectRegistry, smrt } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { beforeAll, describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import type {
  SummaryArticleOptions,
  SummaryArticleResult,
} from './summary-article.js';

// Test agent implementation
interface TestAgentConfig {
  maxItems: number;
  enabled: boolean;
}

@smrt()
class TestAgent extends Agent {
  protected config: TestAgentConfig = {
    maxItems: 10,
    enabled: true,
  };

  // Agent-specific state (automatically persisted)
  itemsProcessed: number = 0;

  async validate(): Promise<void> {
    if (!this.config.enabled) {
      throw new Error('Agent is disabled');
    }
  }

  async run(): Promise<void> {
    // Simulate processing items
    const itemCount = Math.min(5, this.config.maxItems);
    this.itemsProcessed += itemCount;
    this.logger.info(`Processed ${itemCount} items`);
  }
}

describe('@have/agents', () => {
  // Create a SINGLE shared database instance for all tests
  // This ensures all agents share the same in-memory database and tables persist
  let sharedDb: any;

  beforeAll(async () => {
    sharedDb = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  describe('Agent lifecycle', () => {
    it('should initialize with default status', async () => {
      const agent = new TestAgent({
        name: 'test-agent',
        db: sharedDb,
      });

      await agent.initialize();

      expect(agent.status).toBe('initializing');
    });

    it('should execute successfully and update status', async () => {
      const agent = new TestAgent({
        name: 'test-agent-2',
        db: sharedDb,
      });

      await agent.execute();

      expect(agent.status).toBe('idle');
      expect(agent.itemsProcessed).toBe(5);
    });

    it('should handle validation errors', async () => {
      // Create agent with invalid config
      const agent = new TestAgent({
        name: 'test-agent-3',
        db: sharedDb,
      });

      // Override config to make validation fail
      (agent as any).config = { enabled: false, maxItems: 10 };

      await expect(agent.execute()).rejects.toThrow('Agent is disabled');

      expect(agent.status).toBe('error');
    });

    it('should call shutdown lifecycle method', async () => {
      const agent = new TestAgent({
        name: 'test-agent-4',
        db: sharedDb,
      });

      await agent.initialize();
      await agent.shutdown();

      expect(agent.status).toBe('shutdown');
    });
  });

  describe('Configuration', () => {
    it('should use configuration values', async () => {
      const agent = new TestAgent({
        name: 'config-agent',
        db: sharedDb,
      });

      await agent.execute();

      // Config maxItems is 10, but run() processes min(5, maxItems) = 5
      expect(agent.itemsProcessed).toBe(5);
    });
  });

  describe('custom subclass methods', () => {
    @smrt()
    class ArticleAgent extends Agent {
      protected config = {};

      async run(): Promise<void> {}

      async summaryArticle(
        _options: SummaryArticleOptions,
      ): Promise<SummaryArticleResult> {
        return {
          title: 'Weekly Recap',
          summary: 'A weekly recap.',
          body: 'Full body content.',
          dateRange: { start: '2025-01-01', end: '2025-01-07' },
        };
      }
    }

    it('should allow subclasses to declare summaryArticle as a normal method', () => {
      const agent = new ArticleAgent({ name: 'article-agent' });

      expect(typeof agent.summaryArticle).toBe('function');
      expect(Object.hasOwn(agent, 'summaryArticle')).toBe(false);
    });

    it('should not register summaryArticle as a field', () => {
      const fields = ObjectRegistry.getFields('ArticleAgent');

      expect(fields.has('summaryArticle')).toBe(false);
    });

    it('should allow calling the subclass summaryArticle method', async () => {
      const agent = new ArticleAgent({ name: 'callable-agent' });

      const result = await agent.summaryArticle({
        startDate: '2025-01-01',
        endDate: '2025-01-07',
      });

      expect(result.title).toBe('Weekly Recap');
    });
  });

  describe('summaryArticle subclass override (#1016)', () => {
    it('should not shadow a subclass summaryArticle prototype method', () => {
      @smrt()
      class PrototypeArticleAgent extends Agent {
        protected config = {};

        async run(): Promise<void> {}
      }

      PrototypeArticleAgent.prototype.summaryArticle = async () => ({
        title: 'Test',
        summary: 'Summary',
        body: 'Body',
        dateRange: { start: '2025-01-01', end: '2025-01-07' },
      });

      const agent = new PrototypeArticleAgent({ name: 'article-agent' });

      expect(typeof agent.summaryArticle).toBe('function');
      expect(Object.hasOwn(agent, 'summaryArticle')).toBe(false);
    });
  });
});

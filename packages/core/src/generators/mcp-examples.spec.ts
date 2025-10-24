/**
 * Example Project Tests for MCP Generator
 * Demonstrates full workflow with realistic project scenarios
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { boolean, datetime, decimal, integer, text } from '../fields/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { MCPGenerator } from './mcp.js';

describe('MCP Generator - Example Projects', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `smrt-examples-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('Example 1: E-commerce Product Catalog', () => {
    it('should generate MCP server for product catalog', async () => {
      // Define Product model
      @smrt({
        api: { include: ['list', 'get', 'create', 'update'] },
        mcp: { include: ['list', 'get', 'search'] },
        cli: true,
      })
      class Product extends SmrtObject {
        name = text({ required: true });
        description = text();
        price = decimal({ min: 0, required: true });
        stock = integer({ min: 0, default: 0 });
        category = text();

        async search(options: any = {}) {
          return {
            action: 'search',
            query: options.query,
            results: [],
          };
        }
      }

      class ProductCollection extends SmrtCollection<Product> {
        static readonly _itemClass = Product;
      }

      // Register the collection
      ObjectRegistry.registerCollection('Product', ProductCollection);

      // Create example project structure
      const projectDir = join(tmpDir, 'ecommerce');
      await mkdir(join(projectDir, '.smrt', 'mcp-server'), { recursive: true });

      // Generate MCP server
      const generator = new MCPGenerator({
        name: 'ecommerce-mcp',
        version: '1.0.0',
        description: 'E-commerce product catalog MCP server',
      });

      const serverPath = join(projectDir, '.smrt', 'mcp-server', 'index.js');
      await generator.generateServer({
        outputPath: serverPath,
        serverName: 'ecommerce-mcp',
        serverVersion: '1.0.0',
        debug: true,
        generateClaudeConfigFile: true,
        generateReadme: true,
        modular: false,
      });

      // Verify generated server
      const serverContent = await readFile(serverPath, 'utf-8');
      expect(serverContent).toContain('product_list');
      expect(serverContent).toContain('product_get');
      expect(serverContent).toContain('product_search');

      // Verify Claude Desktop config
      const configContent = await readFile(
        join(projectDir, '.smrt', 'mcp-server', 'claude-config.example.json'),
        'utf-8',
      );
      const config = JSON.parse(configContent);
      expect(config.mcpServers).toHaveProperty('ecommerce-mcp');

      // Verify README
      const readmeContent = await readFile(
        join(projectDir, '.smrt', 'mcp-server', 'MCP-README.md'),
        'utf-8',
      );
      expect(readmeContent).toContain('ecommerce-mcp');
      // README contains generic examples, actual tool names are in generated server
      expect(readmeContent).toContain('MCP Server Setup');
    });
  });

  describe('Example 2: Content Management System', () => {
    it('should generate modular MCP server for CMS', async () => {
      // Define Article model
      @smrt({
        api: { include: ['list', 'get', 'create', 'update'] },
        mcp: { include: ['list', 'get', 'summarize', 'analyze'] },
        cli: true,
      })
      class Article extends SmrtObject {
        title = text({ required: true });
        content = text({ required: true });
        author = text();
        publishedAt = datetime();

        async summarize(options: any = {}) {
          const length = options.length || 'medium';
          return {
            action: 'summarize',
            length,
            summary: 'Article summary...',
          };
        }

        async analyze(options: any = {}) {
          return {
            action: 'analyze',
            wordCount: this.content.split(/\s+/).length,
            readingTime: 5,
            sentiment: 'neutral',
          };
        }
      }

      class ArticleCollection extends SmrtCollection<Article> {
        static readonly _itemClass = Article;
      }

      // Register the collection
      ObjectRegistry.registerCollection('Article', ArticleCollection);

      const projectDir = join(tmpDir, 'cms');

      // Generate modular MCP server
      const generator = new MCPGenerator({
        name: 'cms-mcp',
        version: '1.0.0',
        description: 'CMS MCP server with article management',
      });

      const outputDir = join(projectDir, '.smrt', 'mcp-server');
      await generator.generateServer({
        outputPath: join(outputDir, 'index.js'),
        serverName: 'cms-mcp',
        serverVersion: '1.0.0',
        debug: false,
        modular: true,
        generateClaudeConfigFile: true,
        generateReadme: true,
      });

      // Verify modular structure
      const configContent = await readFile(
        join(outputDir, 'config.ts'),
        'utf-8',
      );
      const toolsContent = await readFile(
        join(outputDir, 'tools', 'index.ts'),
        'utf-8',
      );
      const handlersContent = await readFile(
        join(outputDir, 'handlers', 'index.ts'),
        'utf-8',
      );

      expect(configContent).toContain('cms-mcp');
      expect(toolsContent).toContain('article_list');
      expect(toolsContent).toContain('article_summarize');
      expect(toolsContent).toContain('article_analyze');
      expect(handlersContent).toContain("case 'article_summarize'");
      expect(handlersContent).toContain("case 'article_analyze'");
    });
  });

  describe('Example 3: Multi-Model Project', () => {
    it('should generate MCP server for project with multiple models', async () => {
      // Define Order model
      @smrt({
        mcp: { include: ['list', 'get', 'calculate'] },
      })
      class Order extends SmrtObject {
        orderNumber = text({ required: true });
        total = decimal({ min: 0 });
        createdAt = datetime();

        async calculate(options: any = {}) {
          return {
            action: 'calculate',
            total: this.total,
            tax: this.total * 0.1,
            grandTotal: this.total * 1.1,
          };
        }
      }

      class OrderCollection extends SmrtCollection<Order> {
        static readonly _itemClass = Order;
      }

      // Define Customer model
      @smrt({
        mcp: { include: ['list', 'get'] },
      })
      class Customer extends SmrtObject {
        name = text({ required: true });
        email = text({ required: true });
        phone = text();
      }

      class CustomerCollection extends SmrtCollection<Customer> {
        static readonly _itemClass = Customer;
      }

      // Register collections
      ObjectRegistry.registerCollection('Order', OrderCollection);
      ObjectRegistry.registerCollection('Customer', CustomerCollection);

      const projectDir = join(tmpDir, 'multi-model');

      // Generate MCP server
      const generator = new MCPGenerator({
        name: 'multi-model-mcp',
        version: '1.0.0',
      });

      const serverPath = join(projectDir, '.smrt', 'mcp-server', 'index.js');
      await generator.generateServer({
        outputPath: serverPath,
        serverName: 'multi-model-mcp',
        serverVersion: '1.0.0',
        modular: false,
      });

      const content = await readFile(serverPath, 'utf-8');

      // Verify both models are included
      expect(content).toContain('order_list');
      expect(content).toContain('order_get');
      expect(content).toContain('order_calculate');
      expect(content).toContain('customer_list');
      expect(content).toContain('customer_get');
    });
  });

  describe('Example 4: CLI Command Workflow', () => {
    it('should simulate npx smrt generate-mcp command', async () => {
      // Define Task model
      @smrt({ mcp: { include: ['list', 'get', 'complete'] } })
      class Task extends SmrtObject {
        title = text({ required: true });
        completed = boolean({ default: false });

        async complete() {
          this.completed = true;
          await this.save();
          return { action: 'complete', task: this.title };
        }
      }

      class TaskCollection extends SmrtCollection<Task> {
        static readonly _itemClass = Task;
      }

      // Register the collection
      ObjectRegistry.registerCollection('Task', TaskCollection);

      const projectDir = join(tmpDir, 'cli-example');

      // Simulate CLI command: npx smrt generate-mcp --name task-mcp --modular
      const generator = new MCPGenerator({
        name: 'task-mcp',
        version: '1.0.0',
      });

      await generator.generateServer({
        outputPath: join(projectDir, '.smrt', 'mcp-server', 'index.js'),
        serverName: 'task-mcp',
        serverVersion: '1.0.0',
        modular: true,
        debug: false,
        generateClaudeConfigFile: true,
        generateReadme: true,
      });

      // Verify generated files
      const expectedFiles = [
        'index.js',
        'config.ts',
        'tools/index.ts',
        'handlers/index.ts',
        'claude-config.example.json',
        'MCP-README.md',
      ];

      for (const file of expectedFiles) {
        const filePath = join(projectDir, '.smrt', 'mcp-server', file);
        const content = await readFile(filePath, 'utf-8');
        expect(content).toBeTruthy();
      }

      // Verify the server includes task tools
      const toolsContent = await readFile(
        join(projectDir, '.smrt', 'mcp-server', 'tools', 'index.ts'),
        'utf-8',
      );
      expect(toolsContent).toContain('task_list');
      expect(toolsContent).toContain('task_get');
      expect(toolsContent).toContain('task_complete');
    });
  });

  describe('Example 5: Default Path Behavior', () => {
    it('should use .smrt/mcp-server/index.js as default output', async () => {
      // Define Note model
      @smrt({ mcp: { include: ['list', 'get'] } })
      class Note extends SmrtObject {
        content = text();
      }

      class NoteCollection extends SmrtCollection<Note> {
        static readonly _itemClass = Note;
      }

      // Register the collection
      ObjectRegistry.registerCollection('Note', NoteCollection);

      const generator = new MCPGenerator();

      // Don't specify outputPath - should use default
      await generator.generateServer({
        serverName: 'note-mcp',
        serverVersion: '1.0.0',
        modular: false,
      });

      // Verify default location
      const defaultPath = join(
        process.cwd(),
        '.smrt',
        'mcp-server',
        'index.js',
      );
      const content = await readFile(defaultPath, 'utf-8');
      expect(content).toContain('note-mcp');

      // Clean up
      await rm(join(process.cwd(), '.smrt'), { recursive: true, force: true });
    });
  });

  describe('Example 6: Debug Mode for Development', () => {
    it('should generate server with debug logging enabled', async () => {
      // Define Model
      @smrt({ mcp: { include: ['list'] } })
      class Model extends SmrtObject {
        name = text();
      }

      class ModelCollection extends SmrtCollection<Model> {
        static readonly _itemClass = Model;
      }

      // Register the collection
      ObjectRegistry.registerCollection('Model', ModelCollection);

      const projectDir = join(tmpDir, 'debug-dev');

      const generator = new MCPGenerator();

      await generator.generateServer({
        outputPath: join(projectDir, 'mcp-debug.js'),
        serverName: 'debug-server',
        serverVersion: '1.0.0-dev',
        debug: true,
        modular: false,
      });

      const content = await readFile(join(projectDir, 'mcp-debug.js'), 'utf-8');

      expect(content).toContain('const DEBUG = true');
      expect(content).toContain('if (DEBUG) {');
      expect(content).toContain('console.error');
      expect(content).toContain('[MCP]'); // Debug messages use [MCP] prefix
    });
  });
});

/**
 * Integration Tests for MCP Generator
 * Tests with real SMRT objects, database operations, and generated servers
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  McpIntegrationTestProduct,
  McpIntegrationTestProductCollection,
} from '../__tests__/fixtures/mcp-integration-test-classes.js';
import { ObjectRegistry } from '../registry.js';
import { getTestDatabase } from '../testing/database';
import { MCPGenerator } from './mcp.js';

describe('MCPGenerator - Integration Tests', () => {
  let tmpDir: string;
  let generator: MCPGenerator;
  let collection: McpIntegrationTestProductCollection;

  beforeEach(async () => {
    // Create temp directory with UUID for uniqueness in parallel test runs
    tmpDir = join(
      tmpdir(),
      `smrt-mcp-integration-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
    await mkdir(tmpDir, { recursive: true });

    // Register the collection for the test object
    ObjectRegistry.registerCollection(
      'McpIntegrationTestProduct',
      McpIntegrationTestProductCollection,
    );

    generator = new MCPGenerator({
      name: 'test-integration-server',
      version: '1.0.0',
      description: 'Integration test server',
    });

    // Create collection with in-memory database
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    collection = await McpIntegrationTestProductCollection.create({ db });
  });

  afterEach(async () => {
    // Clean up
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('Real SMRT Object Integration', () => {
    it('should generate MCP server from real SMRT collection', async () => {
      const outputPath = join(tmpDir, 'server.js');

      await generator.generateServer({
        outputPath,
        serverName: 'product-server',
        serverVersion: '1.0.0',
        modular: false,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });

      const content = await readFile(outputPath, 'utf-8');

      // Verify generated server includes our test product
      expect(content).toContain('mcpintegrationtestproduct_list');
      expect(content).toContain('mcpintegrationtestproduct_get');
      expect(content).toContain('mcpintegrationtestproduct_analyze');
    });

    it('should include proper tool definitions for real object methods', async () => {
      const tools = await generator.generateTools();

      const productTools = tools.filter((t) =>
        t.name.startsWith('mcpintegrationtestproduct_'),
      );

      // Verify standard CRUD tools
      expect(
        productTools.some((t) => t.name === 'mcpintegrationtestproduct_list'),
      ).toBe(true);
      expect(
        productTools.some((t) => t.name === 'mcpintegrationtestproduct_get'),
      ).toBe(true);

      // Verify custom action tool
      const analyzeTool = productTools.find(
        (t) => t.name === 'mcpintegrationtestproduct_analyze',
      );
      expect(analyzeTool).toBeDefined();
      expect(analyzeTool?.description).toContain('analyze');
      expect(analyzeTool?.inputSchema.properties.id).toBeDefined();
      expect(analyzeTool?.inputSchema.properties.options).toBeDefined();
    });
  });

  describe('Database Integration', () => {
    it('should work with objects persisted to database', async () => {
      // Create and persist test products
      const product1 = await collection.create({
        name: 'Test Widget',
        price: 99.99,
        stock: 10,
      });
      await product1.save();

      const product2 = await collection.create({
        name: 'Premium Gadget',
        price: 199.99,
        stock: 5,
      });
      await product2.save();

      // Generate MCP server
      const outputPath = join(tmpDir, 'db-server.js');
      await generator.generateServer({
        outputPath,
        serverName: 'db-integrated-server',
        serverVersion: '1.0.0',
        modular: false,
      });

      const content = await readFile(outputPath, 'utf-8');

      // Verify server structure
      expect(content).toContain('mcpintegrationtestproduct_list');
      expect(content).toContain('mcpintegrationtestproduct_get');

      // Verify it includes database-related logic
      expect(content).toContain('ObjectRegistry');
      expect(content).toContain('getCollection');
    });

    it('should handle collections with different persistence configs', async () => {
      // Create multiple collections
      const sqliteCollection = await McpIntegrationTestProductCollection.create(
        {
          db: {
            type: 'sqlite',
            url: join(tmpDir, 'test.db'),
          },
        },
      );

      const memoryCollection = await McpIntegrationTestProductCollection.create(
        {
          db: {
            type: 'sqlite',
            url: ':memory:',
          },
        },
      );

      // Generate server
      const outputPath = join(tmpDir, 'multi-db-server.js');
      await generator.generateServer({
        outputPath,
        serverName: 'multi-db-server',
        serverVersion: '1.0.0',
        modular: false,
      });

      const content = await readFile(outputPath, 'utf-8');

      // Verify server can handle multiple persistence configurations
      expect(content).toContain('ObjectRegistry');
      expect(content).toContain('getCollection');
    });
  });

  describe('Custom Action Integration', () => {
    it('should execute custom actions on real objects', async () => {
      // Create product
      const product = await collection.create({
        name: 'Analyzer Test',
        price: 149.99,
        stock: 20,
      });
      await product.save();

      // Execute custom action
      const result = await product.analyze({ detailed: true });

      // Verify result structure
      expect(result.action).toBe('analyze');
      expect(result.product).toBe('Analyzer Test');
      expect(result.price).toBe(149.99);
      expect(result.inStock).toBe(true);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should include custom action handlers in generated server', async () => {
      const outputPath = join(tmpDir, 'custom-action-server.js');

      await generator.generateServer({
        outputPath,
        serverName: 'custom-action-server',
        serverVersion: '1.0.0',
        modular: false,
      });

      const content = await readFile(outputPath, 'utf-8');

      // Verify custom action is included
      expect(content).toContain('mcpintegrationtestproduct_analyze');

      // Verify handler logic
      expect(content).toContain("case 'mcpintegrationtestproduct_analyze'");
    });
  });

  describe('Modular Generation with Real Objects', () => {
    it('should generate modular server structure with real objects', async () => {
      const outputDir = join(tmpDir, 'modular-integration');

      await generator.generateServer({
        outputPath: join(outputDir, 'index.js'),
        serverName: 'modular-integrated',
        serverVersion: '1.0.0',
        modular: true,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });

      // Verify file structure
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
      const indexContent = await readFile(join(outputDir, 'index.js'), 'utf-8');

      // Verify config includes our test objects
      expect(configContent).toContain('modular-integrated');

      // Verify tools include real object tools
      expect(toolsContent).toContain('mcpintegrationtestproduct_list');
      expect(toolsContent).toContain('mcpintegrationtestproduct_get');
      expect(toolsContent).toContain('mcpintegrationtestproduct_analyze');

      // Verify handlers include real object handlers
      expect(handlersContent).toContain(
        "case 'mcpintegrationtestproduct_list'",
      );
      expect(handlersContent).toContain("case 'mcpintegrationtestproduct_get'");
      expect(handlersContent).toContain(
        "case 'mcpintegrationtestproduct_analyze'",
      );

      // Verify index imports from modules
      expect(indexContent).toContain(
        "import { tools } from './tools/index.js'",
      );
      expect(indexContent).toContain(
        "import { handleToolCall } from './handlers/index.js'",
      );
    });
  });

  describe('Configuration Loading Integration', () => {
    it('should generate server with proper config loading', async () => {
      const outputPath = join(tmpDir, 'config-loading-server.js');

      await generator.generateServer({
        outputPath,
        serverName: 'config-loading-server',
        serverVersion: '1.0.0',
        modular: false,
      });

      const content = await readFile(outputPath, 'utf-8');

      // Verify @happyvertical/smrt-config usage
      expect(content).toContain(
        "import { config } from '@happyvertical/smrt-config'",
      );
      expect(content).toContain('await config.load()');
      expect(content).toContain('appConfig?.ai || {}');

      // Verify ObjectRegistry integration
      expect(content).toContain('ObjectRegistry.getCollection');
    });

    it('should handle debug mode in generated server', async () => {
      const outputPath = join(tmpDir, 'debug-server.js');

      await generator.generateServer({
        outputPath,
        serverName: 'debug-server',
        serverVersion: '1.0.0',
        debug: true,
        modular: false,
      });

      const content = await readFile(outputPath, 'utf-8');

      // Verify debug logging is included
      expect(content).toContain('const DEBUG = true');
      expect(content).toContain('if (DEBUG)');
      expect(content).toContain('console.error');
    });
  });

  describe('End-to-End Workflow', () => {
    it('should complete full workflow: object → collection → generator → server', async () => {
      // 1. Create and persist objects
      const product1 = await collection.create({
        name: 'E2E Product 1',
        price: 29.99,
        stock: 100,
      });
      await product1.save();

      const product2 = await collection.create({
        name: 'E2E Product 2',
        price: 49.99,
        stock: 50,
      });
      await product2.save();

      // 2. Verify objects in database
      const count = await collection.count();
      expect(count).toBe(2);

      // 3. Generate MCP server
      const outputPath = join(tmpDir, 'e2e-server.js');
      await generator.generateServer({
        outputPath,
        serverName: 'e2e-server',
        serverVersion: '1.0.0',
        modular: false,
        generateClaudeConfigFile: true,
        generateReadme: true,
      });

      // 4. Verify generated files
      const serverContent = await readFile(outputPath, 'utf-8');
      expect(serverContent).toContain('mcpintegrationtestproduct_list');
      expect(serverContent).toContain('mcpintegrationtestproduct_get');
      expect(serverContent).toContain('mcpintegrationtestproduct_analyze');

      // 5. Verify optional files
      const configPath = join(tmpDir, 'claude-config.example.json');
      const readmePath = join(tmpDir, 'MCP-README.md');

      const configContent = await readFile(configPath, 'utf-8');
      const readmeContent = await readFile(readmePath, 'utf-8');

      expect(JSON.parse(configContent)).toHaveProperty('mcpServers');
      expect(readmeContent).toContain('e2e-server');
    });
  });
});

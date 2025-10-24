/**
 * Example Project Tests for MCP Generator
 * Demonstrates full workflow with realistic project scenarios
 */

import { execSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      // Create example project structure
      const projectDir = join(tmpDir, 'ecommerce');
      await mkdir(join(projectDir, 'src', 'models'), { recursive: true });

      // Write Product model
      await writeFile(
        join(projectDir, 'src', 'models', 'product.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { text, decimal, integer } from '@happyvertical/smrt-core/fields';

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'search'] },
  cli: true
})
export class Product extends SmrtObject {
  name = text({ required: true });
  description = text();
  price = decimal({ min: 0, required: true });
  stock = integer({ min: 0, default: 0 });
  category = text();

  async search(options: any = {}) {
    return {
      action: 'search',
      query: options.query,
      results: []
    };
  }
}
        `.trim(),
      );

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
      expect(readmeContent).toContain('product_list');
    });
  });

  describe('Example 2: Content Management System', () => {
    it('should generate modular MCP server for CMS', async () => {
      const projectDir = join(tmpDir, 'cms');
      await mkdir(join(projectDir, 'src', 'models'), { recursive: true });

      // Write Article model
      await writeFile(
        join(projectDir, 'src', 'models', 'article.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { text, datetime } from '@happyvertical/smrt-core/fields';

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'summarize', 'analyze'] },
  cli: true
})
export class Article extends SmrtObject {
  title = text({ required: true });
  content = text({ required: true });
  author = text();
  publishedAt = datetime();

  async summarize(options: any = {}) {
    const length = options.length || 'medium';
    return {
      action: 'summarize',
      length,
      summary: 'Article summary...'
    };
  }

  async analyze(options: any = {}) {
    return {
      action: 'analyze',
      wordCount: this.content.split(/\\s+/).length,
      readingTime: 5,
      sentiment: 'neutral'
    };
  }
}
        `.trim(),
      );

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
      const projectDir = join(tmpDir, 'multi-model');
      await mkdir(join(projectDir, 'src', 'models'), { recursive: true });

      // Write Order model
      await writeFile(
        join(projectDir, 'src', 'models', 'order.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { text, decimal, datetime } from '@happyvertical/smrt-core/fields';

@smrt({
  mcp: { include: ['list', 'get', 'calculate'] }
})
export class Order extends SmrtObject {
  orderNumber = text({ required: true });
  total = decimal({ min: 0 });
  createdAt = datetime();

  async calculate(options: any = {}) {
    return {
      action: 'calculate',
      total: this.total,
      tax: this.total * 0.1,
      grandTotal: this.total * 1.1
    };
  }
}
        `.trim(),
      );

      // Write Customer model
      await writeFile(
        join(projectDir, 'src', 'models', 'customer.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { text } from '@happyvertical/smrt-core/fields';

@smrt({
  mcp: { include: ['list', 'get'] }
})
export class Customer extends SmrtObject {
  name = text({ required: true });
  email = text({ required: true });
  phone = text();
}
        `.trim(),
      );

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
      const projectDir = join(tmpDir, 'cli-example');
      await mkdir(join(projectDir, 'src'), { recursive: true });

      // Create a simple model
      await writeFile(
        join(projectDir, 'src', 'task.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { text, boolean } from '@happyvertical/smrt-core/fields';

@smrt({ mcp: { include: ['list', 'get', 'complete'] } })
export class Task extends SmrtObject {
  title = text({ required: true });
  completed = boolean({ default: false });

  async complete() {
    this.completed = true;
    await this.save();
    return { action: 'complete', task: this.title };
  }
}
        `.trim(),
      );

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
      const projectDir = join(tmpDir, 'default-path');
      await mkdir(join(projectDir, 'src'), { recursive: true });

      // Simple model
      await writeFile(
        join(projectDir, 'src', 'note.ts'),
        `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { text } from '@happyvertical/smrt-core/fields';

@smrt({ mcp: { include: ['list', 'get'] } })
export class Note extends SmrtObject {
  content = text();
}
        `.trim(),
      );

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
      const projectDir = join(tmpDir, 'debug-dev');
      await mkdir(join(projectDir, 'src'), { recursive: true });

      await writeFile(
        join(projectDir, 'src', 'model.ts'),
        `
@smrt({ mcp: { include: ['list'] } })
export class Model extends SmrtObject {
  name = text();
}
        `.trim(),
      );

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
      expect(content).toContain('[debug-server]');
    });
  });
});

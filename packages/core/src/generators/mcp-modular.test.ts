/**
 * Unit Tests for MCP Generator Modular Features
 * Tests modular generation, configuration handling, and file structure
 */

import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCPGenerator } from './mcp.js';

describe('MCPGenerator - Modular Generation', () => {
  let tmpDir: string;
  let generator: MCPGenerator;

  beforeEach(async () => {
    // Create temp directory for test output
    tmpDir = join(tmpdir(), `smrt-mcp-modular-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    generator = new MCPGenerator({
      name: 'test-mcp-server',
      version: '1.0.0',
      description: 'Test MCP server',
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Default Single-File Generation', () => {
    it('should generate single-file MCP server by default', async () => {
      const outputPath = join(tmpDir, 'server.js');

      await generator.generateServer({
        outputPath,
        serverName: 'test-server',
        serverVersion: '1.0.0',
        modular: false,
      });

      // Verify file exists
      await access(outputPath);

      // Verify file contents
      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('#!/usr/bin/env node');
      expect(content).toContain('test-server');
      expect(content).toContain('@modelcontextprotocol/sdk');
    });

    it('should use @happyvertical/smrt-config for configuration loading', async () => {
      const outputPath = join(tmpDir, 'config-server.js');

      await generator.generateServer({
        outputPath,
        serverName: 'config-test',
        serverVersion: '1.0.0',
        modular: false,
      });

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain(
        "import { config } from '@happyvertical/smrt-config'",
      );
      expect(content).toContain('await config.load()');
      expect(content).toContain('appConfig?.ai || {}');
      expect(content).not.toContain('loadEnvConfig'); // Old approach
    });
  });

  describe('Modular Directory Structure', () => {
    it('should generate modular directory structure when enabled', async () => {
      const outputDir = join(tmpDir, 'modular');

      await generator.generateServer({
        outputPath: join(outputDir, 'index.js'),
        serverName: 'modular-server',
        serverVersion: '1.0.0',
        modular: true,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });

      // Verify all expected files exist
      await access(join(outputDir, 'index.js'));
      await access(join(outputDir, 'config.ts'));
      await access(join(outputDir, 'tools', 'index.ts'));
      await access(join(outputDir, 'handlers', 'index.ts'));
    });

    it('should create properly structured config.ts file', async () => {
      const outputDir = join(tmpDir, 'config-structure');

      await generator.generateServer({
        outputPath: join(outputDir, 'index.js'),
        serverName: 'config-server',
        serverVersion: '2.5.0',
        debug: true,
        modular: true,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });

      const configContent = await readFile(
        join(outputDir, 'config.ts'),
        'utf-8',
      );

      // Verify structure (JSON.stringify uses double quotes)
      expect(configContent).toContain(
        'export const SERVER_NAME = "config-server"',
      );
      expect(configContent).toContain('export const SERVER_VERSION = "2.5.0"');
      expect(configContent).toContain('export const DEBUG = true');
    });

    it('should create tools/index.ts with tool definitions', async () => {
      const outputDir = join(tmpDir, 'tools-structure');

      await generator.generateServer({
        outputPath: join(outputDir, 'index.js'),
        serverName: 'tools-server',
        serverVersion: '1.0.0',
        modular: true,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });

      const toolsContent = await readFile(
        join(outputDir, 'tools', 'index.ts'),
        'utf-8',
      );

      // Verify structure
      expect(toolsContent).toContain('export const tools');
      expect(toolsContent).toContain('Array<{');
      expect(toolsContent).toContain('name: string');
      expect(toolsContent).toContain('description: string');
      expect(toolsContent).toContain('inputSchema: any');
    });

    it('should create handlers/index.ts with tool call handler', async () => {
      const outputDir = join(tmpDir, 'handlers-structure');

      await generator.generateServer({
        outputPath: join(outputDir, 'index.js'),
        serverName: 'handlers-server',
        serverVersion: '1.0.0',
        modular: true,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });

      const handlersContent = await readFile(
        join(outputDir, 'handlers', 'index.ts'),
        'utf-8',
      );

      // Verify structure
      expect(handlersContent).toContain('export async function handleToolCall');
      expect(handlersContent).toContain('name: string');
      expect(handlersContent).toContain('arguments: any');
      expect(handlersContent).toContain('switch (name)');
    });

    it('should create modular index.js that imports from separate files', async () => {
      const outputDir = join(tmpDir, 'modular-index');

      await generator.generateServer({
        outputPath: join(outputDir, 'index.js'),
        serverName: 'modular-index-server',
        serverVersion: '1.0.0',
        modular: true,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });

      const indexContent = await readFile(join(outputDir, 'index.js'), 'utf-8');

      // Verify imports
      expect(indexContent).toContain(
        "import { SERVER_NAME, SERVER_VERSION, DEBUG } from './config.js'",
      );
      expect(indexContent).toContain(
        "import { tools } from './tools/index.js'",
      );
      expect(indexContent).toContain(
        "import { handleToolCall } from './handlers/index.js'",
      );

      // Verify usage
      expect(indexContent).toContain('name: SERVER_NAME');
      expect(indexContent).toContain('version: SERVER_VERSION');
      expect(indexContent).toContain('handleToolCall(request)');
    });
  });

  describe('Default Output Path', () => {
    it('should use .smrt/mcp-server/index.js as default output path', async () => {
      const cwd = process.cwd();
      const expectedPath = join(cwd, '.smrt', 'mcp-server', 'index.js');

      try {
        await generator.generateServer({
          serverName: 'default-path-server',
          serverVersion: '1.0.0',
          modular: false,
          generateClaudeConfigFile: false,
          generateReadme: false,
        });

        // Verify file exists at default location
        await access(expectedPath);

        const content = await readFile(expectedPath, 'utf-8');
        expect(content).toContain('default-path-server');
      } finally {
        // Clean up
        await rm(join(cwd, '.smrt'), { recursive: true, force: true }).catch(
          () => {},
        );
      }
    });
  });

  describe('Debug Mode', () => {
    it('should include debug logging when enabled (single-file)', async () => {
      const outputPath = join(tmpDir, 'debug-single.js');

      await generator.generateServer({
        outputPath,
        serverName: 'debug-single',
        serverVersion: '1.0.0',
        debug: true,
        modular: false,
      });

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('const DEBUG = true');
      expect(content).toContain('if (DEBUG)');
      expect(content).toContain('console.error');
    });

    it('should include debug logging when enabled (modular)', async () => {
      const outputDir = join(tmpDir, 'debug-modular');

      await generator.generateServer({
        outputPath: join(outputDir, 'index.js'),
        serverName: 'debug-modular',
        serverVersion: '1.0.0',
        debug: true,
        modular: true,
      });

      const configContent = await readFile(
        join(outputDir, 'config.ts'),
        'utf-8',
      );
      expect(configContent).toContain('export const DEBUG = true');

      const indexContent = await readFile(join(outputDir, 'index.js'), 'utf-8');
      expect(indexContent).toContain('if (DEBUG)');
    });

    it('should disable debug logging by default', async () => {
      const outputPath = join(tmpDir, 'no-debug.js');

      await generator.generateServer({
        outputPath,
        serverName: 'no-debug',
        serverVersion: '1.0.0',
        modular: false,
      });

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('const DEBUG = false');
    });
  });

  describe('Optional Files', () => {
    it('should not generate optional files by default', async () => {
      const outputPath = join(tmpDir, 'no-optional.js');

      await generator.generateServer({
        outputPath,
        serverName: 'no-optional',
        serverVersion: '1.0.0',
        modular: false,
      });

      const dir = join(tmpDir);
      let configExists = true;
      let readmeExists = true;

      try {
        await access(join(dir, 'claude-config.example.json'));
      } catch {
        configExists = false;
      }

      try {
        await access(join(dir, 'MCP-README.md'));
      } catch {
        readmeExists = false;
      }

      expect(configExists).toBe(false);
      expect(readmeExists).toBe(false);
    });

    it('should generate Claude Desktop config when requested', async () => {
      const outputPath = join(tmpDir, 'with-config', 'server.js');

      await generator.generateServer({
        outputPath,
        serverName: 'with-config',
        serverVersion: '1.0.0',
        generateClaudeConfigFile: true,
        modular: false,
      });

      const configPath = join(
        tmpDir,
        'with-config',
        'claude-config.example.json',
      );
      await access(configPath);

      const configContent = await readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      expect(config).toHaveProperty('mcpServers');
    });

    it('should generate README when requested', async () => {
      const outputPath = join(tmpDir, 'with-readme', 'server.js');

      await generator.generateServer({
        outputPath,
        serverName: 'with-readme',
        serverVersion: '1.0.0',
        generateReadme: true,
        modular: false,
      });

      const readmePath = join(tmpDir, 'with-readme', 'MCP-README.md');
      await access(readmePath);

      const readmeContent = await readFile(readmePath, 'utf-8');
      expect(readmeContent).toContain('with-readme');
    });
  });

  describe('Error Handling', () => {
    it('should create nested directories automatically', async () => {
      const deepPath = join(
        tmpDir,
        'very',
        'deeply',
        'nested',
        'path',
        'server.js',
      );

      await generator.generateServer({
        outputPath: deepPath,
        serverName: 'nested-server',
        serverVersion: '1.0.0',
        modular: false,
      });

      await access(deepPath);
    });

    it('should handle modular generation with nested output directory', async () => {
      const deepDir = join(tmpDir, 'deep', 'nested', 'modular');

      await generator.generateServer({
        outputPath: join(deepDir, 'index.js'),
        serverName: 'deep-modular',
        serverVersion: '1.0.0',
        modular: true,
      });

      await access(join(deepDir, 'index.js'));
      await access(join(deepDir, 'config.ts'));
      await access(join(deepDir, 'tools', 'index.ts'));
      await access(join(deepDir, 'handlers', 'index.ts'));
    });
  });
});

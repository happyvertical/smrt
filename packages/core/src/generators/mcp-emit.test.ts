/**
 * Regression tests for the generated MCP server's emit language (#2279).
 *
 * `smrt generate-mcp` used to write the TypeScript runtime template straight
 * into `.smrt/mcp-server/index.js`, so the file the CLI told you to run died
 * with `SyntaxError: Unexpected identifier 'CallToolRequest'`. The output
 * language now follows the requested extension: JavaScript targets are
 * transpiled, TypeScript targets are written verbatim.
 *
 * Syntax is verified by `node --check` on a `.mjs` copy, which parses the file
 * as an ES module without executing it — the exact failure mode from the issue.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  McpIntegrationTestProduct,
  McpIntegrationTestProductCollection,
} from '../__tests__/fixtures/mcp-integration-test-classes.js';
import { ObjectRegistry } from '../registry.js';
import { MCPGenerator } from './mcp.js';
import {
  generatedSourceExtension,
  renderGeneratedSource,
  resolveGeneratedSourceLanguage,
  transpileGeneratedSource,
} from './mcp-emit.js';

const execFileAsync = promisify(execFile);

/** Parse a generated file as an ES module without running it. */
async function expectParsesAsEsModule(filePath: string): Promise<void> {
  const moduleCopy = `${filePath}.${randomUUID().slice(0, 8)}.mjs`;
  await copyFile(filePath, moduleCopy);
  try {
    await execFileAsync(process.execPath, ['--check', moduleCopy]);
  } finally {
    await rm(moduleCopy, { force: true });
  }
}

describe('resolveGeneratedSourceLanguage', () => {
  it('treats TypeScript extensions as TypeScript', () => {
    expect(resolveGeneratedSourceLanguage('server.ts')).toBe('typescript');
    expect(resolveGeneratedSourceLanguage('/abs/server.mts')).toBe(
      'typescript',
    );
    expect(resolveGeneratedSourceLanguage('/abs/Server.CTS')).toBe(
      'typescript',
    );
  });

  it('treats every other extension as JavaScript', () => {
    expect(resolveGeneratedSourceLanguage('.smrt/mcp-server/index.js')).toBe(
      'javascript',
    );
    expect(resolveGeneratedSourceLanguage('server.mjs')).toBe('javascript');
    expect(resolveGeneratedSourceLanguage('server')).toBe('javascript');
  });

  it('maps the language onto the extension used for sibling modules', () => {
    expect(generatedSourceExtension('typescript')).toBe('.ts');
    expect(generatedSourceExtension('javascript')).toBe('.js');
  });
});

describe('transpileGeneratedSource', () => {
  it('strips type-only imports and annotations while keeping value imports', async () => {
    const output = await transpileGeneratedSource(
      [
        '#!/usr/bin/env node',
        "import { type CallToolRequest, Server } from '@modelcontextprotocol/server';",
        'const STI_TARGETS: Record<string, Record<string, string>> = {};',
        'export function boot(server: Server): Record<string, unknown> {',
        '  return { server, STI_TARGETS };',
        '}',
      ].join('\n'),
    );

    expect(output).toContain('#!/usr/bin/env node');
    expect(output).toContain("from '@modelcontextprotocol/server'");
    expect(output).toContain('Server');
    expect(output).not.toContain('CallToolRequest');
    expect(output).not.toContain('Record<string');
  });

  it('reports the source it failed on instead of writing broken output', async () => {
    await expect(
      transpileGeneratedSource('const = ;', 'index.js'),
    ).rejects.toThrow(/Failed to transpile generated MCP source \(index\.js\)/);
  });

  it('leaves TypeScript untouched when the target is TypeScript', async () => {
    const source = 'const value: number = 1;\n';
    expect(await renderGeneratedSource(source, 'typescript')).toBe(source);
  });
});

describe('MCPGenerator - generated output is runnable (#2279)', () => {
  let tmpDir: string;
  let generator: MCPGenerator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'smrt-mcp-emit-'));
    ObjectRegistry.registerCollection(
      'McpIntegrationTestProduct',
      McpIntegrationTestProductCollection,
    );
    // Reference the item class so the fixture module is not tree-shaken away.
    expect(McpIntegrationTestProduct.name).toBe('McpIntegrationTestProduct');

    generator = new MCPGenerator({
      name: 'emit-test-server',
      version: '1.0.0',
      description: 'Emit test server',
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes JavaScript that node can parse for the default .js target', async () => {
    const outputPath = join(tmpDir, 'index.js');

    await generator.generateServer({
      outputPath,
      serverName: 'emit-js-server',
      serverVersion: '1.0.0',
    });

    const content = await readFile(outputPath, 'utf-8');
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain('emit-js-server');
    // The two annotations that made the shipped `.js` output unparseable.
    expect(content).not.toContain('type CallToolRequest');
    expect(content).not.toContain('const STI_TARGETS: Record<');

    await expectParsesAsEsModule(outputPath);
  });

  it('keeps TypeScript for a .ts target so type-aware runners still work', async () => {
    const outputPath = join(tmpDir, 'index.ts');

    await generator.generateServer({
      outputPath,
      serverName: 'emit-ts-server',
      serverVersion: '1.0.0',
    });

    const content = await readFile(outputPath, 'utf-8');
    expect(content).toContain('type CallToolRequest');
    expect(content).toContain('const STI_TARGETS: Record<');
  });

  it('points the Claude config example at the file it generated', async () => {
    const outputPath = join(tmpDir, 'configured', 'index.js');

    await generator.generateServer({
      outputPath,
      serverName: 'emit-config-server',
      serverVersion: '1.0.0',
      generateClaudeConfigFile: true,
    });

    const config = JSON.parse(
      await readFile(
        join(tmpDir, 'configured', 'claude-config.example.json'),
        'utf-8',
      ),
    );
    const args = config.mcpServers['emit-config-server'].args as string[];

    expect(config.mcpServers['emit-config-server'].command).toBe('node');
    expect(args).toEqual([outputPath]);
    await expectParsesAsEsModule(args[0]);
  });

  it('emits modular files node can resolve and parse', async () => {
    const outputDir = join(tmpDir, 'modular');
    const indexPath = join(outputDir, 'index.js');

    await generator.generateServer({
      outputPath: indexPath,
      serverName: 'emit-modular-server',
      serverVersion: '1.0.0',
      modular: true,
    });

    const indexContent = await readFile(indexPath, 'utf-8');
    expect(indexContent).toContain("from './config.js'");
    expect(indexContent).toContain("from './tools/index.js'");
    expect(indexContent).toContain("from './handlers/index.js'");
    // Unused package imports fail to resolve in consumers that do not depend
    // on them, which is just as fatal as a syntax error.
    expect(indexContent).not.toContain('@happyvertical/sql');
    expect(indexContent).not.toContain('@happyvertical/ai');

    for (const relative of [
      'index.js',
      'config.js',
      join('tools', 'index.js'),
      join('handlers', 'index.js'),
    ]) {
      await expectParsesAsEsModule(join(outputDir, relative));
    }
  });

  it('emits modular TypeScript with matching sibling specifiers', async () => {
    const outputDir = join(tmpDir, 'modular-ts');

    await generator.generateServer({
      outputPath: join(outputDir, 'index.ts'),
      serverName: 'emit-modular-ts-server',
      serverVersion: '1.0.0',
      modular: true,
    });

    const indexContent = await readFile(join(outputDir, 'index.ts'), 'utf-8');
    expect(indexContent).toContain("from './config.ts'");
    expect(indexContent).toContain("from './tools/index.ts'");
    expect(indexContent).toContain("from './handlers/index.ts'");

    const toolsContent = await readFile(
      join(outputDir, 'tools', 'index.ts'),
      'utf-8',
    );
    expect(toolsContent).toContain('Array<{');

    // `arguments` is a reserved binding in every module, TypeScript included.
    const handlersContent = await readFile(
      join(outputDir, 'handlers', 'index.ts'),
      'utf-8',
    );
    expect(handlersContent).not.toContain('arguments: any');
  });

  it('writes the modular entry at the requested path', async () => {
    const outputDir = join(tmpDir, 'named-entry');
    const indexPath = join(outputDir, 'server.js');

    await generator.generateServer({
      outputPath: indexPath,
      serverName: 'emit-named-entry',
      serverVersion: '1.0.0',
      modular: true,
    });

    await expectParsesAsEsModule(indexPath);
  });
});

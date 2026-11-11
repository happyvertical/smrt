import { fileURLToPath } from 'node:url';
/**
 * Regression tests for the generated MCP server's emit language (#2279).
 *
 * `smrt generate-mcp` used to write the TypeScript runtime template straight
 * into `.smrt/mcp-server/index.js`, so the file the CLI told you to run died
 * with `SyntaxError: Unexpected identifier 'CallToolRequest'`. The output
 * language now follows the requested extension: JavaScript targets are
 * transpiled, TypeScript targets are written verbatim.
 *
 * Syntax is verified by `node --check` on a `.mjs` copy, and generated
 * JavaScript entries are started with plain Node against minimal runtime stubs.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  McpIntegrationTestProduct,
  McpIntegrationTestProductCollection,
} from '../__tests__/fixtures/mcp-integration-test-classes.js';
import { ObjectRegistry } from '../registry.js';
import { MCPGenerator } from './mcp.js';
import {
  generatedSiblingExtension,
  renderGeneratedSource,
  resolveGeneratedSourceLanguage,
  transpileGeneratedSource,
} from './mcp-emit.js';
import { generateRuntimeBootstrap } from './mcp-runtime-template.js';

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

/**
 * Install the smallest runtime surface a generated server needs so its emitted
 * JavaScript can start with plain Node without coupling this test to a built
 * copy of smrt-core. The stubs deliberately exercise the generated entry,
 * config, tools, and handlers modules rather than merely syntax-checking them.
 */
async function installGeneratedServerRuntimeStubs(
  outputDirectory: string,
): Promise<void> {
  const nodeModules = join(outputDirectory, 'node_modules');
  const serverPackage = join(nodeModules, '@modelcontextprotocol', 'server');
  const smrtPackage = join(nodeModules, '@happyvertical', 'smrt-core');
  const configPackage = join(nodeModules, '@happyvertical', 'smrt-config');

  await Promise.all([
    mkdir(serverPackage, { recursive: true }),
    mkdir(smrtPackage, { recursive: true }),
    mkdir(configPackage, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(
      join(serverPackage, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { '.': './index.js', './stdio': './stdio.js' },
      }),
    ),
    writeFile(
      join(serverPackage, 'index.js'),
      'export class Server { handlers = new Map(); notifications = []; setRequestHandler(name, handler) { this.handlers.set(name, handler); } async sendToolListChanged() { this.notifications.push("notifications/tools/list_changed"); } }\n',
    ),
    writeFile(
      join(serverPackage, 'stdio.js'),
      "export function serveStdio(factory) { factory(); console.log('smrt-generated-mcp-started'); return { close: async () => {} }; }\n",
    ),
    writeFile(
      join(smrtPackage, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { '.': './index.js', './cookbook/tools': './index.js' },
      }),
    ),
    writeFile(
      join(smrtPackage, 'index.js'),
      `export { COOKBOOK_TOOL_NAMES, getCookbookToolService } from ${JSON.stringify(fileURLToPath(new URL('../../dist/cookbook/tools.js', import.meta.url)))};
export { hasRuntimeExposureGate, isRuntimeModelEnabled, subscribeRuntimeExposure } from ${JSON.stringify(fileURLToPath(new URL('../../dist/runtime-exposure.js', import.meta.url)))}; export const ObjectRegistry = { loadAllManifests() {} }; export function normalizeCustomActionFailure() {} export const SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY = 'smrt';\n`,
    ),
    writeFile(
      join(configPackage, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { '.': './index.js', './cookbook/tools': './index.js' },
      }),
    ),
    writeFile(
      join(configPackage, 'index.js'),
      'export async function loadConfig() { return {}; }\n',
    ),
  ]);
}

/** Run the generated entry with plain Node and observe its startup path. */
async function expectGeneratedServerStarts(filePath: string): Promise<void> {
  await installGeneratedServerRuntimeStubs(join(filePath, '..'));
  const executablePath = await realpath(filePath);
  const { stdout } = await execFileAsync(process.execPath, [executablePath]);
  expect(stdout).toContain('smrt-generated-mcp-started');
}

describe('generated TypeScript stays erasable', () => {
  /**
   * A `.ts` target is written verbatim and documented as runnable through
   * Node's type stripping, which only erases — it cannot transform. Parameter
   * properties, enums, and namespaces would make the emitted server fail with
   * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
   */
  it('emits no transform-only syntax, including for task actions', () => {
    const source = generateRuntimeBootstrap({
      name: 'erasable-server',
      tools: [
        {
          name: 'widget_reindex',
          description: 'Reindex widgets',
          inputSchema: { type: 'object' },
        },
      ],
      taskActions: {
        widget_reindex: { objectName: 'widget', objectType: 'Widget' },
      },
    });

    expect(source).toContain('McpTaskExtensionTransport');
    expect(() => stripTypeScriptTypes(source, { mode: 'strip' })).not.toThrow();
  });
});

describe('resolveGeneratedSourceLanguage', () => {
  it('treats TypeScript extensions as TypeScript', () => {
    expect(resolveGeneratedSourceLanguage('server.ts')).toBe('typescript');
    expect(resolveGeneratedSourceLanguage('/abs/server.mts')).toBe(
      'typescript',
    );
    expect(resolveGeneratedSourceLanguage('/abs/Server.MTS')).toBe(
      'typescript',
    );
  });

  it('treats every other module extension as JavaScript', () => {
    expect(resolveGeneratedSourceLanguage('.smrt/mcp-server/index.js')).toBe(
      'javascript',
    );
    expect(resolveGeneratedSourceLanguage('server.mjs')).toBe('javascript');
    expect(resolveGeneratedSourceLanguage('server')).toBe('javascript');
  });

  it('rejects CommonJS targets, which no generated server can run', () => {
    // The generated server uses `import` and `import.meta.url`.
    expect(() => resolveGeneratedSourceLanguage('server.cjs')).toThrow(
      /ES module/,
    );
    expect(() => resolveGeneratedSourceLanguage('server.cts')).toThrow(
      /ES module/,
    );
    expect(() => generatedSiblingExtension('server.cjs')).toThrow(/ES module/);
  });

  it("gives sibling modules the entry point's own extension", () => {
    expect(generatedSiblingExtension('out/index.ts')).toBe('.ts');
    expect(generatedSiblingExtension('out/index.mts')).toBe('.mts');
    expect(generatedSiblingExtension('out/index.js')).toBe('.js');
    // An `.mjs` entry in a CommonJS package needs `.mjs` siblings, or Node
    // parses them as CommonJS and their `export` statements fail.
    expect(generatedSiblingExtension('out/index.mjs')).toBe('.mjs');
    expect(generatedSiblingExtension('out/server')).toBe('.js');
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
        '  return { server, serverConstructor: Server, STI_TARGETS };',
        '}',
      ].join('\n'),
    );

    expect(output).toContain('#!/usr/bin/env node');
    expect(output).toMatch(/from ["']@modelcontextprotocol\/server["']/);
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
    await expectGeneratedServerStarts(outputPath);
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
    expect(indexContent).toMatch(/from ["']\.\/config\.js["']/);
    expect(indexContent).toMatch(/from ["']\.\/tools\/index\.js["']/);
    expect(indexContent).toMatch(/from ["']\.\/handlers\/index\.js["']/);
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
    await expectGeneratedServerStarts(indexPath);
  });

  it.each([
    false,
    true,
  ])('preserves descriptor metadata in the actual emitted listing (modular=%s)', async (modular) => {
    const tools = (await generator.generateTools()).slice(0, 2);
    expect(tools).toHaveLength(2);
    // Keep the exact generator-owned descriptors and their source identities.
    Object.assign(tools[0], {
      title: 'Review',
      icons: [{ src: 'https://example.test/icon.svg' }],
      _meta: {
        ui: { resourceUri: 'ui://review/view', visibility: ['app'] },
        'example.extension': { enabled: true },
      },
    });
    delete tools[1].annotations;
    vi.spyOn(generator, 'generateToolDefinitions').mockResolvedValue(tools);
    const outputDir = join(
      tmpDir,
      modular ? 'metadata-modular' : 'metadata-single',
    );
    const outputPath = join(outputDir, 'index.mjs');
    await generator.generateServer({
      outputPath,
      modular,
      generateClaudeConfigFile: false,
      generateReadme: false,
    });
    await installGeneratedServerRuntimeStubs(outputDir);
    const probe = join(outputDir, 'list.mjs');
    await writeFile(
      probe,
      `import { createServer } from './index.mjs'; const server = await createServer(); console.log(JSON.stringify(await server.handlers.get('tools/list')()));`,
    );
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: outputDir,
    });
    const result = JSON.parse(stdout.trim());
    expect(result.tools).toEqual(
      [...tools].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      ),
    );
  });

  it.each([
    false,
    true,
  ])('delegates edited model lists/calls to the shared live generator (modular=%s)', async (modular) => {
    const outputDir = join(tmpDir, modular ? 'app-modular' : 'app-single');
    await generator.generateServer({
      outputPath: join(outputDir, 'index.mjs'),
      modular,
    });
    await installGeneratedServerRuntimeStubs(outputDir);
    const toolsPath = fileURLToPath(
      new URL('../../dist/cookbook/tools.js', import.meta.url),
    );
    const probe = join(outputDir, 'app-probe.mjs');
    await writeFile(
      probe,
      `
      import {createServer} from './index.mjs';
      import {setCookbookToolService} from ${JSON.stringify(toolsPath)};
      const contexts = [];
      setCookbookToolService({
        async list() {return [];},
        async modelTools(context) {
          contexts.push(context);
          return {
            async generateTools() {return [{name:'projects_create',inputSchema:{type:'object',properties:{projectTitle:{type:'string'}}}}];},
            async handleToolCall(request) {return {content:[{type:'text',text:'Created Garden.'}],structuredContent:{name:request.params.name,title:request.params.arguments.projectTitle}};},
          };
        },
      });
      const server = await createServer();
      const listed = await server.handlers.get('tools/list')({});
      const result = await server.handlers.get('tools/call')({params:{name:'projects_create',arguments:{projectTitle:'Garden'}}});
      console.log(JSON.stringify({listed,result,contexts}));
    `,
    );
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: outputDir,
      env: {
        ...process.env,
        SMRT_MCP_TENANT_ID: 'tenant',
        SMRT_MCP_USER_ID: 'owner',
      },
    });
    const result = JSON.parse(stdout.trim());
    expect(result.listed.tools).toEqual([
      {
        name: 'projects_create',
        inputSchema: {
          type: 'object',
          properties: { projectTitle: { type: 'string' } },
        },
      },
    ]);
    expect(result.result.structuredContent).toEqual({
      name: 'projects_create',
      title: 'Garden',
    });
    expect(result.contexts).toEqual([
      { surface: 'mcp', tenantId: 'tenant', userId: 'owner' },
      { surface: 'mcp', tenantId: 'tenant', userId: 'owner' },
    ]);
  });

  it.each([
    false,
    true,
  ])('serves installed cookbook tools from the shared service (modular=%s)', async (modular) => {
    const outputDir = join(
      tmpDir,
      modular ? 'cookbook-modular' : 'cookbook-single',
    );
    await generator.generateServer({
      outputPath: join(outputDir, 'index.mjs'),
      modular,
    });
    await installGeneratedServerRuntimeStubs(outputDir);
    const toolsPath = fileURLToPath(
      new URL('../../dist/cookbook/tools.js', import.meta.url),
    );
    const gatePath = fileURLToPath(
      new URL('../../dist/runtime-exposure.js', import.meta.url),
    );
    const probe = join(outputDir, 'cookbook-probe.mjs');
    await writeFile(
      probe,
      `
      import { createServer } from './index.mjs';
      import { setCookbookToolService } from ${JSON.stringify(toolsPath)};
      import { notifyRuntimeExposureChanged } from ${JSON.stringify(gatePath)};
      let on = true;
      const contexts = [];
      const definition = {name:'recipes.search',description:'Installed recipes',inputSchema:{type:'object'},outputSchema:{type:'object'}};
      setCookbookToolService({
        async list(context) { contexts.push(context); return on ? [definition] : []; },
        async invoke(name, args, context) {
          contexts.push(context);
          if (!on) throw new Error('forbidden');
          return {status:'ok',summary:'Found Billing.',recipes:[{id:'billing'}]};
        },
      });
      const server = await createServer();
      const list = () => server.handlers.get('tools/list')({});
      const call = () => server.handlers.get('tools/call')({params:{name:'recipes.search',arguments:{query:'send invoices'}}});
      const offered = (await list()).tools.find(tool => tool.name === 'recipes.search');
      const result = await call();
      on = false; notifyRuntimeExposureChanged();
      const removed = !(await list()).tools.some(tool => tool.name === 'recipes.search');
      const refused = (await call()).isError;
      console.log(JSON.stringify({offered,result,removed,refused,contexts,notifications:server.notifications}));
    `,
    );
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: outputDir,
      env: {
        ...process.env,
        SMRT_MCP_TENANT_ID: 'tenant',
        SMRT_MCP_USER_ID: 'owner',
      },
    });
    const result = JSON.parse(stdout.trim());
    expect(result.offered).toMatchObject({ name: 'recipes.search' });
    expect(result.result.structuredContent).toMatchObject({
      summary: 'Found Billing.',
      recipes: [{ id: 'billing' }],
    });
    expect(result.removed).toBe(true);
    expect(result.refused).toBe(true);
    expect(result.contexts.length).toBeGreaterThan(0);
    expect(
      result.contexts.every(
        (context: any) =>
          context.tenantId === 'tenant' &&
          context.userId === 'owner' &&
          context.surface === 'mcp',
      ),
    ).toBe(true);
    expect(result.notifications).toContain('notifications/tools/list_changed');
  });

  it.each([
    false,
    true,
  ])('gates emitted catalogs and calls and emits list_changed without regeneration (modular=%s)', async (modular) => {
    const outputDir = join(tmpDir, modular ? 'live-modular' : 'live-single');
    const outputPath = join(outputDir, 'index.mjs');
    await generator.generateServer({ outputPath, modular });
    await installGeneratedServerRuntimeStubs(outputDir);
    const rootStub = join(
      outputDir,
      'node_modules/@happyvertical/smrt-core/index.js',
    );
    await writeFile(
      rootStub,
      `${await readFile(rootStub, 'utf8')}\nObjectRegistry.getExposureModel = (name) => ({ qualifiedName: name });`,
    );
    const tool = (await generator.generateToolDefinitions())[0];
    const gatePath = fileURLToPath(
      new URL('../../dist/runtime-exposure.js', import.meta.url),
    );
    await writeFile(
      join(outputDir, 'live-probe.mjs'),
      `
      import { createServer } from './index.mjs';
      import { setRuntimeExposureGate, notifyRuntimeExposureChanged } from ${JSON.stringify(gatePath)};
      let enabled = false;
      setRuntimeExposureGate({ isEnabled: () => enabled });
      const server = await createServer();
      const list = () => server.handlers.get('tools/list')({});
      const call = () => server.handlers.get('tools/call')({ params: { name: ${JSON.stringify(tool.name)}, arguments: {} } });
      const before = (await list()).tools.length;
      const refused = (await call()).isError;
      enabled = true; notifyRuntimeExposureChanged();
      const after = (await list()).tools.length;
      enabled = false; notifyRuntimeExposureChanged();
      const disabledAgain = (await list()).tools.length;
      server.onclose(); notifyRuntimeExposureChanged();
      console.log(JSON.stringify({ before, refused, after, disabledAgain, notifications: server.notifications }));
    `,
    );
    const { stdout } = await execFileAsync(process.execPath, [
      join(outputDir, 'live-probe.mjs'),
    ]);
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
    expect(result).toMatchObject({
      before: 0,
      refused: true,
      disabledAgain: 0,
      notifications: [
        'notifications/tools/list_changed',
        'notifications/tools/list_changed',
      ],
    });
    expect(result.after).toBeGreaterThan(0);
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

  it('gives an .mjs modular entry .mjs siblings and specifiers', async () => {
    const outputDir = join(tmpDir, 'modular-mjs');

    await generator.generateServer({
      outputPath: join(outputDir, 'index.mjs'),
      serverName: 'emit-modular-mjs',
      serverVersion: '1.0.0',
      modular: true,
    });

    const indexContent = await readFile(join(outputDir, 'index.mjs'), 'utf-8');
    expect(indexContent).toMatch(/from ["']\.\/config\.mjs["']/);
    expect(indexContent).toMatch(/from ["']\.\/tools\/index\.mjs["']/);
    expect(indexContent).toMatch(/from ["']\.\/handlers\/index\.mjs["']/);

    for (const relative of [
      'index.mjs',
      'config.mjs',
      join('tools', 'index.mjs'),
      join('handlers', 'index.mjs'),
    ]) {
      await expectParsesAsEsModule(join(outputDir, relative));
    }
    await expectGeneratedServerStarts(join(outputDir, 'index.mjs'));
  });

  it('refuses a CommonJS output path instead of writing an unusable file', async () => {
    await expect(
      generator.generateServer({
        outputPath: join(tmpDir, 'index.cjs'),
        serverName: 'emit-cjs-server',
      }),
    ).rejects.toThrow(/ES module/);
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

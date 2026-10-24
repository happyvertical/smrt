import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import type { SmartObjectDefinition } from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { MCPGenerator } from './mcp.js';

const PACKAGE = '@fixture/mcp-static-collection';
const KEY = `${PACKAGE}:PortfolioResource`;
const called = vi.fn();

class PortfolioResource extends SmrtCollection<SmrtObject> {
  async initialize() {
    return this;
  }
  static createQuestion(projectId: string, title: string) {
    if (typeof title !== 'string') throw new Error('Invalid title');
    called(this, projectId, title);
    if (title === 'fail') throw new Error('Upstream action failed');
    return { projectId, title, receiver: this.name };
  }
  instanceOnly() {
    called('instance');
  }
}

const methods = {
  createQuestion: {
    name: 'createQuestion',
    isStatic: true,
    parameters: [
      { name: 'projectId', type: 'string', optional: false },
      { name: 'title', type: 'string', optional: false },
    ],
    returnType: 'object',
    isPublic: true,
    async: false,
  },
  missingStatic: {
    name: 'missingStatic',
    isStatic: true,
    parameters: [],
    returnType: 'void',
    isPublic: true,
    async: false,
  },
  instanceOnly: {
    name: 'instanceOnly',
    isStatic: false,
    parameters: [],
    returnType: 'void',
    isPublic: true,
    async: false,
  },
};

describe('qualified manifest-backed MCP static collection actions (#4308)', () => {
  let restoreRegistry: () => void;
  let generator: MCPGenerator;
  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    called.mockClear();
    ObjectRegistry.registerFromManifest(
      KEY,
      {
        name: 'portfolioresource',
        className: 'PortfolioResource',
        qualifiedName: KEY,
        packageName: PACKAGE,
        collection: 'portfolioresources',
        filePath: '/fixture/PortfolioResource.ts',
        extends: 'SmrtCollection',
        fields: {},
        methods,
        decoratorConfig: { mcp: { include: Object.keys(methods) } },
      } as SmartObjectDefinition,
      PACKAGE,
    );
    ObjectRegistry.registerCollection(KEY, PortfolioResource);
    generator = new MCPGenerator(
      { classNames: [KEY] },
      { user: { id: 'fixture-user' } },
    );
  });
  afterEach(() => restoreRegistry());
  const call = (generator: MCPGenerator, action: string, args = {}) =>
    generator.handleToolCall({
      method: 'tools/call',
      params: { name: `portfolioresource_${action}`, arguments: args },
    });

  it('invokes the discovered static tool on the exact registered collection constructor', async () => {
    expect(ObjectRegistry.getClass(KEY)?.constructor).not.toBe(
      PortfolioResource,
    );
    const tool = (await generator.generateTools()).find(
      (tool) => tool.name === 'portfolioresource_createquestion',
    );
    expect(tool?.inputSchema.properties).toMatchObject({
      projectId: { type: 'string' },
      title: { type: 'string' },
    });
    const response = await call(generator, 'createquestion', {
      projectId: 'project-1',
      title: 'Question',
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({
      data: {
        projectId: 'project-1',
        title: 'Question',
        receiver: 'PortfolioResource',
      },
    });
    expect(called).toHaveBeenCalledExactlyOnceWith(
      PortfolioResource,
      'project-1',
      'Question',
    );
  });

  it('keeps a live model static ahead of the collection static with the same name', async () => {
    class StaticModel extends SmrtObject {
      static createQuestion() {
        return { receiver: 'model' };
      }
    }
    const key = `${PACKAGE}:StaticModel`;
    ObjectRegistry.register(StaticModel, {
      packageName: PACKAGE,
      mcp: { include: ['createQuestion'] },
    });
    ObjectRegistry.getMethods(key).set('createQuestion', {
      ...methods.createQuestion,
      parameters: [],
    });
    ObjectRegistry.registerCollection(key, PortfolioResource);
    const response = await new MCPGenerator(
      { classNames: [key] },
      { user: { id: 'fixture-user' } },
    ).handleToolCall({
      method: 'tools/call',
      params: { name: 'staticmodel_createquestion', arguments: {} },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({ data: { receiver: 'model' } });
    expect(called).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', {}, 'Unknown tool'],
    ['list', {}, 'Unknown tool'],
    ['missingstatic', {}, 'Static method'],
    ['instanceonly', {}, 'ID is required'],
    [
      'createquestion',
      { id: 'wrong', projectId: 'p', title: 'q' },
      'does not accept an ID',
    ],
    ['createquestion', { projectId: 'p' }, 'title'],
    ['createquestion', { projectId: 'p', title: 42 }, 'title'],
  ])('fails closed for %s with %j', async (action, args, message) => {
    const response = await call(generator, action, args);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain(message);
    expect(called).not.toHaveBeenCalled();
  });

  it('keeps authentication required for the registered static action', async () => {
    const response = await call(
      new MCPGenerator({ classNames: [KEY] }),
      'createquestion',
      { projectId: 'p', title: 'q' },
    );
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Authentication required');
    expect(called).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])('executes the emitted server (modular=%s) with the registered static receiver', async (modular) => {
    const directory = await mkdtemp(join(tmpdir(), 'smrt-4308-'));
    try {
      await generator.generateServer({
        outputPath: join(directory, 'index.mjs'),
        modular,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });
      const packages: Record<string, Record<string, string>> = {
        '@modelcontextprotocol/server': {
          'package.json': JSON.stringify({
            type: 'module',
            exports: { '.': './index.js', './stdio': './stdio.js' },
          }),
          'index.js':
            'export class Server { handlers = new Map(); setRequestHandler(name, handler) { this.handlers.set(name, handler); } }',
          'stdio.js': 'export function serveStdio() {}',
        },
        '@happyvertical/smrt-config': {
          'package.json': JSON.stringify({
            type: 'module',
            exports: './index.js',
          }),
          'index.js': 'export async function loadConfig() { return {}; }',
        },
        '@happyvertical/smrt-core': {
          'package.json': JSON.stringify({
            type: 'module',
            exports: './index.js',
          }),
          'index.js': `class CollectionReceiver {
            static createQuestion(projectId, title) { return { projectId, title, receiver: this.name }; }
          }
          export const ObjectRegistry = {
            loadAllManifests() {},
            async getCollection(key) { if (key !== ${JSON.stringify(KEY)}) throw new Error('Wrong identity'); return {}; },
            getClass(key) { if (key !== ${JSON.stringify(KEY)}) throw new Error('Wrong identity'); return { constructor: class ManifestStub {}, collectionConstructor: CollectionReceiver }; },
            getConfig() { return {}; },
          };
          export function normalizeCustomActionFailure() {}
          export const SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY = 'smrt';`,
        },
      };
      for (const [name, files] of Object.entries(packages)) {
        const path = join(directory, 'node_modules', name);
        await mkdir(path, { recursive: true });
        for (const [name, content] of Object.entries(files))
          await writeFile(join(path, name), content);
      }
      const probe = join(directory, 'probe.mjs');
      await writeFile(
        probe,
        `import { createServer } from './index.mjs';
        const server = await createServer();
        const call = server.handlers.get('tools/call');
        const results = [];
        for (const [name, args] of [['portfolioresource_createquestion', { projectId: 'p', title: 'q' }], ['portfolioresource_missingstatic', {}], ['portfolioresource_unknown', {}], ['portfolioresource_list', {}], ['portfolioresource_instanceonly', {}]]) {
          results.push(await call({ params: { name, arguments: args } }));
        }
        console.log(JSON.stringify(results));`,
      );
      const { stdout } = await promisify(execFile)(process.execPath, [probe], {
        cwd: directory,
      });
      const [success, ...failures] = JSON.parse(stdout.trim());
      expect(success.isError).not.toBe(true);
      expect(success.structuredContent).toEqual({
        data: { projectId: 'p', title: 'q', receiver: 'CollectionReceiver' },
      });
      expect(
        failures.map((result: { isError?: boolean }) => result.isError),
      ).toEqual([true, true, true, true]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('propagates action failure as an MCP error', async () => {
    const response = await call(generator, 'createquestion', {
      projectId: 'p',
      title: 'fail',
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Upstream action failed');
  });
});

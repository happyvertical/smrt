import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { MCPGenerator } from './mcp.js';
import { canonicalMcpToolNames } from './mcp-tool-name.js';

const exec = promisify(execFile);
const standardName = /^[A-Za-z0-9_.-]{1,64}$/;
const methods = [
  'seedDefaultRolePersonalizationPermissions',
  'seedDefaultRolePersonalizationPermissionsAgain',
  'record_payment',
  '$special',
  "quoted'action",
];
class RolePermissionCollection extends SmrtObject {
  static "quoted'action"() {
    return { receiver: 'quoted' };
  }
  static seedDefaultRolePersonalizationPermissions() {
    return { receiver: 'first' };
  }
  static seedDefaultRolePersonalizationPermissionsAgain() {
    return { receiver: 'second' };
  }
  static record_payment() {
    return { receiver: 'underscore' };
  }
  static $special() {
    return { receiver: 'special' };
  }
}
class MCP_Underscore extends SmrtObject {
  static record_payment() {
    return { receiver: 'class_underscore' };
  }
}
function generator() {
  ObjectRegistry.register(RolePermissionCollection, {
    mcp: { include: methods },
  });
  ObjectRegistry.register(MCP_Underscore, {
    mcp: { include: ['record_payment'] },
  });
  for (const [name, actions] of [
    ['RolePermissionCollection', methods],
    ['MCP_Underscore', ['record_payment']],
  ] as const) {
    for (const action of actions)
      ObjectRegistry.getMethods(name).set(action, {
        name: action,
        async: false,
        isPublic: true,
        isStatic: true,
        returnType: 'any',
        parameters: [],
      });
  }
  ObjectRegistry.invalidateAllInheritanceCaches();
  return new MCPGenerator({}, { user: { id: 'test-user' } });
}

describe('canonical MCP tool identifiers (#3219)', () => {
  it('preserves compliant names and distinguishes long and sanitized common prefixes independent of order', () => {
    const raw = [
      'a'.repeat(64),
      'a'.repeat(65),
      `${'a'.repeat(64)}b`,
      'x$run',
      'x/run',
    ];
    const entries = raw.map((name) => ({
      name,
      target: { objectName: 'Object', action: name },
    }));
    const names = canonicalMcpToolNames(entries);
    expect(names[0]).toBe(raw[0]);
    expect(names.every((name) => standardName.test(name))).toBe(true);
    expect(new Set(names).size).toBe(raw.length);
    expect(canonicalMcpToolNames([...entries].reverse()).reverse()).toEqual(
      names,
    );
    expect(() => canonicalMcpToolNames([entries[0], entries[0]])).toThrow(
      'Duplicate',
    );
    const reserved = {
      name: names[1],
      target: { objectName: 'Other', action: 'run' },
    };
    expect(() => canonicalMcpToolNames([entries[1], reserved])).toThrow(
      'collision',
    );
  });

  it('advertises compliant aliases and executes each original target, rejecting unadvertised raw and forged aliases', async () => {
    const instance = generator();
    const collection = vi.fn().mockResolvedValue({});
    (instance as any).getCollection = collection;
    const tools = await instance.generateTools();
    expect(tools).toHaveLength(6);
    expect(tools.every((tool) => standardName.test(tool.name))).toBe(true);
    expect(tools.map((tool) => tool.name)).toContain(
      'mcp_underscore_record_payment',
    );
    expect(tools.map((tool) => tool.name)).toContain(
      'rolepermissioncollection_record_payment',
    );
    const receivers = [];
    for (const tool of tools) {
      const result = await instance.handleToolCall({
        method: 'tools/call',
        params: { name: tool.name, arguments: {} },
      });
      expect(result.isError).not.toBe(true);
      receivers.push(JSON.parse(result.content[0].text).receiver);
    }
    expect(receivers.sort()).toEqual([
      'class_underscore',
      'first',
      'quoted',
      'second',
      'special',
      'underscore',
    ]);
    collection.mockClear();
    for (const name of [
      'rolepermissioncollection_seeddefaultrolepersonalizationpermissions',
      'rolepermissioncollection_$special',
      `${tools[0].name}x`,
    ]) {
      const result = await instance.handleToolCall({
        method: 'tools/call',
        params: { name, arguments: {} },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    }
    expect(collection).not.toHaveBeenCalled();
  });

  it('rejects ambiguous raw aliases across packages before case-sensitive hashing can hide the collision', async () => {
    class CanonicalCollisionUpperFixture extends SmrtObject {
      static actionLongEnoughToCrossTheProtocolBoundary() {
        return 'upper';
      }
    }
    class CanonicalCollisionLowerFixture extends SmrtObject {
      static actionLongEnoughToCrossTheProtocolBoundary() {
        return 'lower';
      }
    }
    Object.defineProperty(CanonicalCollisionUpperFixture, 'name', {
      value: 'CaseCollisionProtocolObjectName',
    });
    Object.defineProperty(CanonicalCollisionLowerFixture, 'name', {
      value: 'casecollisionprotocolobjectname',
    });
    const entries = [
      [CanonicalCollisionUpperFixture, '@canonical/upper'],
      [CanonicalCollisionLowerFixture, '@canonical/lower'],
    ] as const;
    try {
      for (const [target, packageName] of entries) {
        ObjectRegistry.register(target, {
          packageName,
          mcp: { include: ['actionLongEnoughToCrossTheProtocolBoundary'] },
        });
      }
      await expect(
        new MCPGenerator({}, { user: { id: 'test-user' } }).generateTools(),
      ).rejects.toThrow('Duplicate MCP tool name');
    } finally {
      for (const [target, packageName] of entries)
        ObjectRegistry.register(target, { packageName, mcp: false });
    }
  });

  it('uses the original method and class identity for canonical task aliases', async () => {
    class Long_Task_Identifier_Protocol_Probe extends SmrtObject {
      async performLongRunningCanonicalProtocolAction(options: {
        prompt: string;
      }) {
        return options;
      }
    }
    const method = 'performLongRunningCanonicalProtocolAction';
    ObjectRegistry.register(Long_Task_Identifier_Protocol_Probe, {
      mcp: { include: [method], tasks: [method] },
    });
    try {
      ObjectRegistry.getMethods('Long_Task_Identifier_Protocol_Probe').set(
        method,
        {
          name: method,
          async: true,
          isPublic: true,
          isStatic: false,
          returnType: 'Promise<any>',
          parameters: [{ name: 'options', type: 'any', optional: false }],
        },
      );
      ObjectRegistry.invalidateAllInheritanceCaches();
      let invocation: any;
      const instance = new MCPGenerator(
        {},
        {
          user: { id: 'test-user' },
          taskStore: {
            async createTask(input) {
              invocation = input;
              return {
                taskId: 'canonical-task',
                status: 'working',
                createdAt: '2026-09-30T00:00:00.000Z',
                lastUpdatedAt: '2026-09-30T00:00:00.000Z',
                ttlMs: 60000,
              };
            },
          },
        },
      );
      const tool = (await instance.generateTools()).find((tool) =>
        tool.name.startsWith('long_task_identifier_protocol_p'),
      );
      if (!tool) throw new Error('Canonical task tool not advertised');
      expect(tool.name).toMatch(standardName);
      expect(await instance.supportsTaskTool(tool.name)).toBe(true);
      expect(
        await instance.supportsTaskTool(
          `long_task_identifier_protocol_probe_${method.toLowerCase()}`,
        ),
      ).toBe(false);
      await instance.createTask({
        method: 'tools/call',
        params: {
          name: tool.name,
          arguments: { id: 'object-1', options: { prompt: 'test' } },
        },
      });
      expect(invocation).toMatchObject({
        objectId: 'object-1',
        method,
        invocationArgs: [{ prompt: 'test' }],
      });
    } finally {
      ObjectRegistry.register(Long_Task_Identifier_Protocol_Probe, {
        mcp: false,
      });
    }
  });

  it.each([
    false,
    true,
  ])('executes the same bindings in emitted plain Node modules (modular=%s)', async (modular) => {
    const dir = await mkdtemp(join(tmpdir(), 'smrt-canonical-mcp-'));
    try {
      await writeFile(join(dir, 'package.json'), '{"type":"module"}');
      await generator().generateServer({
        outputPath: join(dir, 'index.js'),
        modular,
      });
      const packages = {
        '@modelcontextprotocol/server': {
          'index.js':
            'export class Server { handlers = {}; setRequestHandler(name, fn) { this.handlers[name] = fn; } }',
          'stdio.js': 'export function serveStdio() {}',
        },
        '@happyvertical/smrt-config': {
          'index.js': 'export async function loadConfig() { return {}; }',
        },
        '@happyvertical/smrt-core': {
          'index.js': `
          const classes = {
            RolePermissionCollection: { seedDefaultRolePersonalizationPermissions() {return {receiver:'first'}}, seedDefaultRolePersonalizationPermissionsAgain() {return {receiver:'second'}}, record_payment() {return {receiver:'underscore'}}, $special() {return {receiver:'special'}}, ["quoted'action"]() {return {receiver:'quoted'}} },
            MCP_Underscore: { record_payment() {return {receiver:'class_underscore'}} }
          };
          export const ObjectRegistry = { loadAllManifests() {}, getClass(name) { if (!classes[name]) throw Error('wrong class '+name); return {constructor: classes[name]}; }, async getCollection(name) {if(!classes[name]) throw Error('wrong collection '+name); return {};} };
          export function normalizeCustomActionFailure() {}
          export const SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY = 'smrt';
        `,
        },
      };
      for (const [name, files] of Object.entries(packages)) {
        const directory = join(dir, 'node_modules', name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, 'package.json'),
          JSON.stringify({
            type: 'module',
            exports: { '.': './index.js', './stdio': './stdio.js' },
          }),
        );
        for (const [file, content] of Object.entries(files))
          await writeFile(join(directory, file), content);
      }
      await writeFile(
        join(dir, 'probe.mjs'),
        `
        import { createServer } from './index.js';
        const server = await createServer();
        const { tools } = await server.handlers['tools/list']({});
        const results = [];
        for (const tool of tools) results.push(await server.handlers['tools/call']({params:{name:tool.name,arguments:{}}}));
        results.push(await server.handlers['tools/call']({params:{name:'rolepermissioncollection_seeddefaultrolepersonalizationpermissions',arguments:{}}}));
        console.log(JSON.stringify({tools,results}));
      `,
      );
      const { stdout } = await exec(
        process.execPath,
        [join(dir, 'probe.mjs')],
        { cwd: dir },
      );
      const { tools, results } = JSON.parse(stdout.trim());
      expect(tools.every((tool: any) => standardName.test(tool.name))).toBe(
        true,
      );
      expect(
        results
          .slice(0, -1)
          .map((result: any) => {
            expect(result.isError).not.toBe(true);
            return JSON.parse(result.content[0].text).receiver;
          })
          .sort(),
      ).toEqual([
        'class_underscore',
        'first',
        'quoted',
        'second',
        'special',
        'underscore',
      ]);
      expect(results.at(-1).isError).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

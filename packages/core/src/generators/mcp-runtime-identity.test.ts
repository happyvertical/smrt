/**
 * #3490: a generated MCP server dispatches to the exact class its generator
 * was scoped to. Two packages register `PickedThing`; a generator scoped to
 * `@fixture/pick-b3490:PickedThing` emits that class's catalog, and the
 * emitted single-file and modular servers must resolve every collection,
 * write policy and class lookup through that registry identity — never
 * through the simple name, which also names the other package's class.
 *
 * The emitted server runs in plain Node against recording stubs of its
 * runtime packages (the `mcp-emit.test.ts` harness), so the assertion is on
 * what the generated code actually asks the registry for.
 */
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { MCPGenerator } from './mcp.js';

const execFileAsync = promisify(execFile);
const PICK_A = '@fixture/pick-a3490:PickedThing';
const PICK_B = '@fixture/pick-b3490:PickedThing';

function named<T extends typeof SmrtObject>(ctor: T, name: string): T {
  Object.defineProperty(ctor, 'name', { value: name });
  return ctor;
}

/** Runtime stubs that record every name the generated code resolves. */
async function installRecordingRuntime(outputDirectory: string) {
  const nodeModules = join(outputDirectory, 'node_modules');
  const packages = {
    server: join(nodeModules, '@modelcontextprotocol', 'server'),
    core: join(nodeModules, '@happyvertical', 'smrt-core'),
    config: join(nodeModules, '@happyvertical', 'smrt-config'),
  };
  await Promise.all(
    Object.values(packages).map((dir) => mkdir(dir, { recursive: true })),
  );
  const item = `{
    toPublicJSON() { return {}; },
    async save() {},
    async delete() {},
    ping() { return { ok: true }; },
  }`;
  await Promise.all([
    writeFile(
      join(packages.server, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { '.': './index.js', './stdio': './stdio.js' },
      }),
    ),
    writeFile(
      join(packages.server, 'index.js'),
      'export class Server { handlers = new Map(); setRequestHandler(name, handler) { this.handlers.set(name, handler); } }\n',
    ),
    writeFile(
      join(packages.server, 'stdio.js'),
      'export function serveStdio(factory) { return { close: async () => {} }; }\n',
    ),
    writeFile(
      join(packages.core, 'package.json'),
      JSON.stringify({ type: 'module', exports: './index.js' }),
    ),
    writeFile(
      join(packages.core, 'index.js'),
      `export const resolved = [];
const record = (kind, name) => resolved.push(kind + ':' + name);
export const ObjectRegistry = {
  loadAllManifests() {},
  async getCollection(name) {
    record('collection', name);
    return {
      async list() { return []; },
      async count() { return 0; },
      async get() { return ${item}; },
      async create() { return ${item}; },
      async delete() { record('delete', name); },
      async withAuditMutation(item, action, callback) {
        record('audit-' + action, name);
        return callback(item);
      },
    };
  },
  getConfig(name) { record('config', name); return {}; },
  getFields(name) { record('fields', name); return new Map(); },
  getClass(name) { record('class', name); return { constructor: { ping() { return { ok: true }; } } }; },
};
export function normalizeCustomActionFailure() { return undefined; }
export const SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY = 'smrt';
`,
    ),
    writeFile(
      join(packages.config, 'package.json'),
      JSON.stringify({ type: 'module', exports: './index.js' }),
    ),
    writeFile(
      join(packages.config, 'index.js'),
      'export async function loadConfig() { return {}; }\n',
    ),
  ]);
}

describe('generated MCP server dispatch identity (#3490)', () => {
  const PickA = named(class extends SmrtObject {}, 'PickedThing');
  const PickB = named(
    class extends SmrtObject {
      ping() {
        return { ok: true };
      }
    },
    'PickedThing',
  );
  Object.defineProperty(PickA.prototype, 'ping', {
    value() {
      return { ok: true };
    },
  });
  const include = ['list', 'get', 'create', 'update', 'delete', 'ping'];
  let restoreRegistry: () => void;
  let tmpDir: string;

  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.register(PickA, {
      packageName: '@fixture/pick-a3490',
      tableName: 'picked_things_a',
      mcp: { include },
    });
    ObjectRegistry.register(PickB, {
      packageName: '@fixture/pick-b3490',
      tableName: 'picked_things_b',
      mcp: { include },
    });
    tmpDir = await mkdtemp(join(tmpdir(), 'smrt-3490-runtime-'));
  });

  afterAll(async () => {
    restoreRegistry();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['single-file', false],
    ['modular', true],
  ])('the %s server resolves every lookup through the scoped class', async (label, modular) => {
    const outputDir = join(tmpDir, label);
    const generator = new MCPGenerator({ classNames: [PICK_B] });
    const tools = await generator.generateTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'pickedthing_create',
      'pickedthing_delete',
      'pickedthing_get',
      'pickedthing_list',
      'pickedthing_ping',
      'pickedthing_update',
    ]);
    await generator.generateServer({
      outputPath: join(outputDir, 'index.mjs'),
      modular,
      generateClaudeConfigFile: false,
      generateReadme: false,
    });
    await installRecordingRuntime(outputDir);
    const calls = [
      ['pickedthing_list', {}],
      ['pickedthing_get', { id: 'b-1' }],
      ['pickedthing_create', { title: 'x' }],
      ['pickedthing_update', { id: 'b-1', title: 'y' }],
      ['pickedthing_delete', { id: 'b-1' }],
      ['pickedthing_ping', { id: 'b-1' }],
    ];
    const probe = join(outputDir, 'probe.mjs');
    await writeFile(
      probe,
      `import { createServer } from './index.mjs';
import { resolved } from '@happyvertical/smrt-core';
const server = await createServer();
const call = server.handlers.get('tools/call');
const results = [];
for (const [name, args] of ${JSON.stringify(calls)}) {
  const result = await call({ params: { name, arguments: args } });
  results.push([name, result.isError === true, result.content?.[0]?.text]);
}
console.log(JSON.stringify({ resolved, results }));
`,
    );
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: outputDir,
    });
    const { resolved, results } = JSON.parse(stdout.trim()) as {
      resolved: string[];
      results: Array<[string, boolean, string]>;
    };

    expect(results.filter(([, isError]) => isError)).toEqual([]);
    expect(resolved.length).toBeGreaterThan(0);
    // Every collection, policy and class lookup names the scoped class.
    expect(resolved.filter((entry) => !entry.endsWith(`:${PICK_B}`))).toEqual(
      [],
    );
    expect(resolved).toContain(`collection:${PICK_B}`);
    expect(resolved).toContain(`config:${PICK_B}`);
    expect(resolved).toContain(`audit-updated:${PICK_B}`);
    expect(resolved).toContain(`delete:${PICK_B}`);

    // The emitted tool targets carry the registry identity too.
    const emitted = (
      await Promise.all(
        (
          await readdir(outputDir, { recursive: true })
        )
          .filter(
            (file) => file.endsWith('.mjs') && !file.includes('node_modules'),
          )
          .map((file) => readFile(join(outputDir, file), 'utf-8')),
      )
    ).join('\n');
    expect(emitted).toMatch(
      /registryKey["']?\s*:\s*["']@fixture\/pick-b3490:PickedThing["']/,
    );
  });
});

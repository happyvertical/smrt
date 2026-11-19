/**
 * Both emitted MCP servers, run for real.
 *
 * The other emitted-server suites start the generated code against stand-ins
 * for `@happyvertical/smrt-core`. Here the single-file and the modular server
 * are each started in a child process against the built core package and a
 * real SQLite file, with only the MCP transport package replaced by a recorder
 * of the registered handlers. That proves, end to end through the emitted
 * code:
 *
 * - tool arguments set fields and nothing else: a create or update carrying
 *   every service option key and `options` is saved normally, and one carrying
 *   an underscore key is refused
 *   in the server's own database;
 * - a list or get filter with two keys for one column and operator is refused,
 *   and a range on one column is served.
 *
 * The model is data-defined (`registerRuntimeModel`) so the child process can
 * register the same model from the built package. Requires `pnpm build`, like
 * the other suites that read `dist/`.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { registerRuntimeModel } from '../runtime-model.js';
import { SMRT_SERVICE_OPTION_KEYS } from '../service-options.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { MCPGenerator } from './mcp.js';

const execFileAsync = promisify(execFile);

const MODEL = {
  name: 'EmittedServerNote',
  packageName: '@test/emitted-servers',
  tableName: 'emitted_server_notes',
  fields: {
    label: { type: 'text' as const },
    amount: { type: 'integer' as const },
  },
};
const MODEL_KEY = `${MODEL.packageName}:${MODEL.name}`;
const TOOL = 'emittedservernote';

// Inside the core package and ignored by git, so the emitted server resolves
// `@happyvertical/smrt-core` to this package's own build.
const root = join(
  import.meta.dirname,
  '../../.smrt/emitted-mcp-servers-real-core',
);

type ToolCall = [tool: string, args: Record<string, unknown>];
type ToolResult = { tool: string; isError: boolean; text: string };

describe('emitted MCP servers against the built core package', () => {
  let restoreRegistry: () => void;
  const appDb = join(root, 'app.db');
  const otherDb = join(root, 'other.db');
  const unprepared = join(root, 'unprepared.db');

  const open = (url: string): Promise<DatabaseInterface> =>
    getTestDatabase({ type: 'sqlite', url, classes: [MODEL_KEY] });
  const labelsIn = async (url: string): Promise<string[]> => {
    const db = await open(url);
    try {
      const result = await db.query(
        `SELECT label FROM ${MODEL.tableName} ORDER BY label`,
      );
      return result.rows.map((row: Record<string, unknown>) =>
        String(row.label),
      );
    } finally {
      await db.close?.();
    }
  };

  /** Every key a tool call must not be able to turn into a service. */
  const serviceKeys = (): Record<string, unknown> => ({
    ...Object.fromEntries(
      SMRT_SERVICE_OPTION_KEYS.map((key) => [key, { from: key }]),
    ),
    db: `file:${otherDb}`,
    persistence: { type: 'sqlite', url: unprepared },
    ai: { baseUrl: 'http://127.0.0.1:9/other/v1' },
    options: { db: { type: 'sqlite', url: unprepared } },
  });
  /** Underscore keys are not fields: a value for one is refused. */
  const underscoreKeys = (): Record<string, unknown> => ({
    _insertOnly: true,
    _skipLoad: false,
    _className: 'Other',
  });

  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    registerRuntimeModel(MODEL);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    // Two databases with the model's table: the server's own, and one a
    // write would land in if a database could be taken from tool arguments.
    for (const url of [appDb, otherDb]) await (await open(url)).close?.();

    // The child registers the same model from the built package.
    writeFileSync(
      join(root, 'model.mjs'),
      `import { registerRuntimeModel } from '@happyvertical/smrt-core';\nregisterRuntimeModel(${JSON.stringify(MODEL)});\n`,
    );

    for (const modular of [false, true]) {
      const directory = join(root, modular ? 'modular' : 'single');
      mkdirSync(directory, { recursive: true });
      const generator = new MCPGenerator({
        name: 'emitted-servers-real-core',
        version: '1',
        classNames: [MODEL_KEY],
      });
      await generator.generateServer({
        outputPath: join(directory, 'index.mjs'),
        modular,
        generateClaudeConfigFile: false,
        generateReadme: false,
      });
      // Only the MCP transport is replaced: it records the handlers the
      // emitted server registers so a test can call them directly.
      const transport = join(
        directory,
        'node_modules/@modelcontextprotocol/server',
      );
      mkdirSync(transport, { recursive: true });
      writeFileSync(
        join(transport, 'package.json'),
        JSON.stringify({
          type: 'module',
          exports: { '.': './index.js', './stdio': './stdio.js' },
        }),
      );
      writeFileSync(
        join(transport, 'index.js'),
        'export class Server { handlers = new Map(); setRequestHandler(name, handler) { this.handlers.set(name, handler); } async sendToolListChanged() {} }\n',
      );
      writeFileSync(
        join(transport, 'stdio.js'),
        'export function serveStdio() { return { close: async () => {} }; }\n',
      );
      // Runs the calls in order; `$ID` in later arguments is the id the
      // first successful create returned.
      writeFileSync(
        join(directory, 'probe.mjs'),
        `import '../model.mjs';
import { createServer } from './index.mjs';
const server = await createServer();
const call = server.handlers.get('tools/call');
const results = [];
let id;
for (const [tool, args] of JSON.parse(process.env.EMITTED_SERVER_CALLS)) {
  const resolved = JSON.parse(JSON.stringify(args).replaceAll('$ID', id ?? ''));
  const result = await call({ params: { name: tool, arguments: resolved } });
  const text = result.content?.[0]?.text ?? '';
  if (!id && result.isError !== true && tool.endsWith('_create')) id = JSON.parse(text).id;
  results.push({ tool, isError: result.isError === true, text });
}
console.log('EMITTED_SERVER_RESULTS' + JSON.stringify(results));
`,
      );
    }
  }, 120_000);

  afterAll(() => {
    restoreRegistry?.();
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (
    server: 'single' | 'modular',
    calls: ToolCall[],
  ): Promise<ToolResult[]> => {
    const { stdout } = await execFileAsync(process.execPath, ['probe.mjs'], {
      cwd: join(root, server),
      env: {
        ...process.env,
        DATABASE_TYPE: 'sqlite',
        DATABASE_URL: appDb,
        EMITTED_SERVER_CALLS: JSON.stringify(calls),
      },
    });
    const line = stdout
      .split('\n')
      .find((entry) => entry.startsWith('EMITTED_SERVER_RESULTS'));
    if (!line) throw new Error(`No results from the ${server} server`);
    return JSON.parse(line.slice('EMITTED_SERVER_RESULTS'.length));
  };

  it('generated both servers for the model', () => {
    expect(ObjectRegistry.getClass(MODEL_KEY)?.name).toBe(MODEL.name);
    expect(existsSync(join(root, 'single/index.mjs'))).toBe(true);
    expect(existsSync(join(root, 'modular/handlers/index.mjs'))).toBe(true);
  });

  it.each([
    'single',
    'modular',
  ] as const)('the %s server saves create and update normally when the arguments carry service keys', async (server) => {
    const created = `${server}-created`;
    const updated = `${server}-updated`;
    const results = await run(server, [
      [`${TOOL}_create`, { label: created, amount: 2, ...serviceKeys() }],
      [`${TOOL}_get`, { id: '$ID' }],
      [`${TOOL}_update`, { id: '$ID', label: updated, ...serviceKeys() }],
      [`${TOOL}_get`, { id: '$ID' }],
    ]);

    expect(results.map((result) => result.isError)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(JSON.parse(results[0].text)).toMatchObject({
      label: created,
      amount: 2,
    });
    expect(JSON.parse(results[1].text).label).toBe(created);
    expect(JSON.parse(results[3].text).label).toBe(updated);
    // No key of the arguments became a field of the stored row either.
    for (const key of [...SMRT_SERVICE_OPTION_KEYS, 'options']) {
      expect(JSON.parse(results[3].text)).not.toHaveProperty(key);
    }

    expect(await labelsIn(appDb)).toContain(updated);
    expect(await labelsIn(appDb)).not.toContain(created);
    expect(await labelsIn(otherDb)).toEqual([]);
    expect(existsSync(unprepared)).toBe(false);
  });

  it.each([
    'single',
    'modular',
  ] as const)('the %s server refuses create and update arguments that carry an underscore key', async (server) => {
    const label = `${server}-underscore`;
    const results = await run(server, [
      [`${TOOL}_create`, { label, amount: 1 }],
      ...Object.entries(underscoreKeys()).flatMap(
        ([key, value]): ToolCall[] => [
          [`${TOOL}_create`, { label: `${label}-refused`, [key]: value }],
          [
            `${TOOL}_update`,
            { id: '$ID', label: `${label}-changed`, [key]: value },
          ],
        ],
      ),
      [`${TOOL}_get`, { id: '$ID' }],
    ]);
    expect(results[0].isError).toBe(false);
    for (const refused of results.slice(1, -1)) {
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('cannot be written');
    }
    expect(JSON.parse(results[results.length - 1].text).label).toBe(label);
    expect(await labelsIn(appDb)).not.toContain(`${label}-refused`);
  });

  it.each([
    'single',
    'modular',
  ] as const)('the %s server refuses a filter with two keys for one column and serves a range', async (server) => {
    const label = `${server}-filtered`;
    const results = await run(server, [
      [`${TOOL}_create`, { label, amount: 3 }],
      [`${TOOL}_list`, { where: { label, Label: 'other' } }],
      [`${TOOL}_list`, { where: { amount: [3], 'amount in': [4] } }],
      [`${TOOL}_get`, { id: { id: '$ID', label, Label: 'other' } }],
      [`${TOOL}_list`, { where: { label, 'amount >=': 1, 'amount <': 5 } }],
      [`${TOOL}_get`, { id: '$ID' }],
    ]);

    expect(results.map((result) => result.isError)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
    for (const refused of results.slice(1, 3)) {
      expect(refused.text).toContain('Invalid WHERE clause');
      expect(refused.text).not.toContain(label);
    }
    // An `id` argument names a row by a string; an object is refused before
    // it can become a filter.
    expect(results[3].text).toContain("'id' must be a non-empty string.");
    expect(results[3].text).not.toContain(label);
    expect(results[4].text).toContain(label);
    expect(JSON.parse(results[5].text).label).toBe(label);
  });
});

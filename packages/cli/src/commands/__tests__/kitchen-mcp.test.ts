import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addManifest, createRecipeIndex } from '../cookbook/recipe-index.js';
import {
  catalogFromIndex,
  loadLibrary,
  packageIdOf,
} from '../kitchen/mcp/catalog.js';
import { KITCHEN_TOOLS, KitchenSession } from '../kitchen/mcp/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '../../..');
const repoRoot = resolve(cliRoot, '../..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');

let work: string;
let manifests: string;
let template: string;

const C = '@happyvertical/smrt-commerce';

/** A tiny manifest per package: every recipe the library names, with one model each. */
function writeManifests(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const field = (type = 'text') => ({ type, required: false });
  const models: Record<string, Record<string, string[]>> = {
    '@happyvertical/smrt-commerce': {
      Customer: ['name', 'creditLimit', 'paymentTerms'],
      Invoice: ['number', 'total', 'currency', 'terms'],
      Order: ['number', 'currency', 'terms'],
      PurchaseOrder: ['currency'],
      WholesaleOrder: ['currency', 'terms'],
      Estimate: ['currency', 'terms'],
      Agreement: ['currency', 'terms'],
      InvoiceLineItem: ['taxRate'],
      ContractLineItem: ['taxRate'],
      ProductionOrder: ['quantity'],
    },
    '@happyvertical/smrt-inventory': { StockLevel: ['quantity'] },
    '@happyvertical/smrt-ledgers': { Entry: ['memo'] },
    '@happyvertical/smrt-products': { Product: ['name'] },
  };
  const recipeIds: Record<string, string[]> = {
    '@happyvertical/smrt-commerce': [
      'commerce.customers',
      'commerce.invoicing',
      'commerce.purchases',
      'commerce.sales',
      'commerce.vendors',
      'commerce.wholesale',
    ],
    '@happyvertical/smrt-inventory': ['inventory.stock'],
    '@happyvertical/smrt-ledgers': ['ledgers.bookkeeping'],
    '@happyvertical/smrt-products': ['products.ingredients', 'products.simple'],
  };
  for (const [packageName, classes] of Object.entries(models)) {
    const first = `${packageName}:${Object.keys(classes)[0]}`;
    const objects = Object.fromEntries(
      Object.entries(classes).map(([name, fields]) => [
        `${packageName}:${name}`,
        {
          className: name,
          fields: Object.fromEntries(fields.map((f) => [f, field()])),
          decoratorConfig: {},
        },
      ]),
    );
    writeFileSync(
      join(dir, `${packageIdOf(packageName)}.json`),
      JSON.stringify({
        packageName,
        packageVersion: '1.0.0',
        objects,
        recipes: recipeIds[packageName].map((id) => ({
          id,
          className: 'R',
          label: id.split('.')[1].replace(/^./, (c) => c.toUpperCase()),
          summary: `Manage ${id.split('.')[1]}`,
          synonyms: [],
          models: [first],
          nav: [{ label: id.split('.')[1], model: first }],
          requires: [],
        })),
      }),
    );
  }
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'kitchen-mcp-'));
  manifests = join(work, 'manifests');
  writeManifests(manifests);
  template = join(work, 'template');
  mkdirSync(join(template, 'src'), { recursive: true });
  writeFileSync(
    join(template, 'package.json'),
    JSON.stringify({
      name: 'template',
      version: '0.0.0',
      dependencies: { '@happyvertical/smrt-core': '^1.0.0' },
    }),
  );
  writeFileSync(join(template, 'src', 'index.ts'), 'export {};\n');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('the Kitchen library and catalog', () => {
  it('ships the same starting points as the core fixtures', () => {
    const fixtures = join(repoRoot, 'packages/core/src/cookbook/__fixtures__');
    const shipped = join(cliRoot, 'cookbooks');
    expect(readdirSync(shipped).sort()).toEqual(readdirSync(fixtures).sort());
    for (const file of readdirSync(shipped)) {
      expect(readFileSync(join(shipped, file), 'utf8')).toBe(
        readFileSync(join(fixtures, file), 'utf8'),
      );
    }
    const warnings: string[] = [];
    expect(loadLibrary([], warnings).map((c) => c.id)).toEqual([
      'bakery',
      'mechanic',
      'welder',
      'yoga-studio',
    ]);
    expect(warnings).toEqual([]);
  });

  it('builds recipes and models from manifests', () => {
    const index = createRecipeIndex();
    addManifest(
      index,
      JSON.parse(readFileSync(join(manifests, 'commerce.json'), 'utf8')),
      'test',
    );
    const catalog = catalogFromIndex(index);
    expect(catalog.recipes.map((r) => r.id)).toContain('commerce.sales');
    const customer = catalog.models.find((m) => m.id === `${C}:Customer`);
    expect(customer).toMatchObject({
      name: 'Customer',
      packageId: 'commerce',
      exposed: true,
    });
    expect(customer?.fields?.map((f) => f.name)).toContain('creditLimit');
  });
});

describe('KitchenSession (in process)', () => {
  it('forgets nothing it was told and refuses unknown plans and bad input', async () => {
    const session = new KitchenSession({
      dir: work,
      manifests: [manifests],
      registry: false,
    });
    const missing = await session.call('get_plan', { planId: 'plan-nope' });
    expect(missing.data).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const bad = await session.call('apply_plan', { planId: 'x' });
    expect(bad.data).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    const relative = await session.call('start_plan', {});
    const planId = relative.data.planId as string;
    const notAbsolute = await session.call('apply_plan', {
      planId,
      dir: 'relative/dir',
      confirm: true,
    });
    expect(notAbsolute.data).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });
});

describe('undo through run_commands', () => {
  it('runs a lone undo as a command', async () => {
    const session = new KitchenSession({
      dir: work,
      manifests: [manifests],
      registry: false,
    });
    const { data: started } = await session.call('start_plan', {});
    const planId = started.planId as string;
    const added = await session.call('run_commands', {
      planId,
      commands: [{ name: 'add_recipes', input: { ids: ['commerce.sales'] } }],
    });
    expect(added.data.ok).toBe(true);
    const undoId = (added.data.receipt as { undoId: string }).undoId;
    const undone = await session.call('run_commands', {
      planId,
      commands: [{ name: 'undo', input: { undoId } }],
    });
    expect(undone.data.ok).toBe(true);
    expect((undone.data.snapshot as { recipes: unknown[] }).recipes).toEqual(
      [],
    );
  });
});

describe('smrt kitchen mcp over stdio', () => {
  let client: Client;
  let transport: StdioClientTransport;
  const ajv = new Ajv2020({ strict: false, allErrors: true });

  /** Call a tool, check its structured output against the published schema. */
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const tool = KITCHEN_TOOLS.find((t) => t.name === name);
    const validate = ajv.compile(tool?.outputSchema ?? {});
    expect(
      validate(result.structuredContent),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    return {
      data: result.structuredContent as Record<string, any>,
      text: (result.content[0] as { text: string }).text,
      isError: Boolean(result.isError),
    };
  }

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: tsx,
      args: [
        join(cliRoot, 'src/index.ts'),
        'kitchen',
        'mcp',
        '--no-registry',
        '--manifests',
        manifests,
        '--template',
        template,
      ],
      cwd: work,
      // No inference credentials are passed or needed.
      env: { PATH: process.env.PATH ?? '', HOME: work },
      stderr: 'pipe',
    });
    client = new Client({ name: 'kitchen-test', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists the tools with schemas and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'apply_plan',
        'export_plan',
        'get_plan',
        'list_cookbooks',
        'run_commands',
        'search_recipes',
        'start_plan',
        'validate_plan',
      ].sort(),
    );
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.description?.length).toBeGreaterThan(20);
      expect(typeof tool.annotations?.title).toBe('string');
      // No inference credential is asked for anywhere.
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(
        /api[_-]?key|token|password|secret|credential/i,
      );
    }
    for (const name of [
      'list_cookbooks',
      'search_recipes',
      'get_plan',
      'validate_plan',
      'export_plan',
    ]) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
    expect(byName.get('apply_plan')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName.get('start_plan')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    const batch = byName.get('run_commands')?.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(batch.required).toEqual(['planId', 'commands']);
    expect(Object.keys(batch.properties).sort()).toEqual([
      'commands',
      'expectedRevision',
      'id',
      'planId',
    ]);
  });

  it('lists cookbooks and searches recipes from the real manifests', async () => {
    const cookbooks = await call('list_cookbooks');
    expect(cookbooks.data.cookbooks.map((c: { id: string }) => c.id)).toEqual([
      'bakery',
      'mechanic',
      'welder',
      'yoga-studio',
    ]);
    const found = await call('search_recipes', { query: 'invoic' });
    expect(found.data.recipes.map((r: { id: string }) => r.id)).toEqual([
      'commerce.invoicing',
    ]);
    expect(
      (await call('search_recipes', { limit: 3 })).data.recipes,
    ).toHaveLength(3);
  });

  it('plans, retries idempotently, validates, exports and applies', async () => {
    const started = await call('start_plan', { name: 'Lotus' });
    expect(started.data.ok).toBe(true);
    const planId = started.data.planId as string;
    const first = started.data.snapshot.revision as number;
    expect(started.data.snapshot.app.name).toBe('Lotus');

    const commands = [
      {
        name: 'add_recipes',
        input: { ids: ['commerce.vendors', 'inventory.stock'] },
      },
      { name: 'set_settings', input: { currency: 'CAD', taxRate: 5 } },
    ];
    const changed = await call('run_commands', {
      planId,
      id: 'batch-1',
      expectedRevision: first,
      commands,
    });
    expect(changed.data.ok).toBe(true);
    const revision = changed.data.snapshot.revision as number;
    expect(revision).toBeGreaterThan(first);
    expect(
      changed.data.snapshot.recipes.map((r: { id: string }) => r.id),
    ).toContain('commerce.vendors');
    expect(changed.data.snapshot.settings).toMatchObject({
      currency: 'CAD',
      taxRate: 5,
    });

    // The same batch id again applies nothing, even though expectedRevision is stale.
    const retry = await call('run_commands', {
      planId,
      id: 'batch-1',
      expectedRevision: first,
      commands,
    });
    expect(retry.data).toMatchObject({ ok: true, replayed: true });
    expect(retry.data.snapshot.revision).toBe(revision);
    expect((await call('get_plan', { planId })).data.snapshot.revision).toBe(
      revision,
    );

    // A new id on a stale revision is a conflict; a failing batch changes nothing.
    const stale = await call('run_commands', {
      planId,
      id: 'batch-2',
      expectedRevision: first,
      commands: [{ name: 'hide', input: { id: 'nothing' } }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error.code).toBe('conflict');
    const atomic = await call('run_commands', {
      planId,
      id: 'batch-3',
      commands: [
        { name: 'set_name', input: { name: 'Changed' } },
        { name: 'add_recipes', input: { ids: ['no.such'] } },
      ],
    });
    expect(atomic.data.error.code).toBe('batch_failed');
    expect(atomic.data.snapshot.app.name).toBe('Lotus');

    const valid = await call('validate_plan', { planId });
    expect(valid.data, valid.text).toMatchObject({ ok: true, valid: true });
    expect(valid.data.packages).toContain('@happyvertical/smrt-commerce');

    const exported = await call('export_plan', { planId });
    const cookbook = JSON.parse(exported.data.text);
    expect(cookbook.recipes).toContain('commerce.vendors');
    expect(exported.data.cookbook.version).toBe(1);

    const dir = join(work, 'project');
    // Without confirm nothing is written.
    const preview = await call('apply_plan', { planId, dir });
    expect(preview.isError).toBe(true);
    expect(preview.data.error.code).toBe('confirmation_required');
    expect(existsSync(dir)).toBe(false);
    // dryRun wins over confirm.
    const dry = await call('apply_plan', {
      planId,
      dir,
      confirm: true,
      dryRun: true,
    });
    expect(dry.data.error.code).toBe('confirmation_required');
    expect(existsSync(dir)).toBe(false);

    const applied = await call('apply_plan', { planId, dir, confirm: true });
    expect(applied.data).toMatchObject({
      ok: true,
      applied: true,
      installed: false,
      mode: 'new',
      config: 'create',
    });
    const written = JSON.parse(
      readFileSync(join(dir, 'smrt.cookbook.json'), 'utf8'),
    );
    expect(written.recipes).toEqual(cookbook.recipes);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toContain(
      '@happyvertical/smrt-inventory',
    );
    expect(pkg.name).toBe('lotus');
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);

    // Re-applying the same plan changes nothing.
    const again = await call('apply_plan', { planId, dir, confirm: true });
    expect(again.data).toMatchObject({
      ok: true,
      mode: 'update',
      config: 'unchanged',
    });
  }, 60_000);

  it('starts from a library cookbook and says what the catalog lacks', async () => {
    const started = await call('start_plan', { cookbook: 'yoga-studio' });
    expect(started.data.snapshot.app.cookbook).toBe('yoga-studio');
    expect(started.data.snapshot.unavailable).toContain('events.calendar');
    const checked = await call('validate_plan', {
      planId: started.data.planId,
    });
    expect(checked.data.valid).toBe(false);
    expect(checked.data.errors.join('\n')).toContain(
      'recipe "events.calendar" does not exist',
    );
    expect(checked.text).toMatch(/^Not valid:/);
    // The unknown cookbook id is a typed error, not a crash.
    const unknown = await call('start_plan', { cookbook: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.data.error.code).toBe('invalid_input');
  });

  it('keeps stdout to the protocol', async () => {
    const child = spawn(
      tsx,
      [join(cliRoot, 'src/index.ts'), 'kitchen', 'mcp', '--no-registry'],
      {
        cwd: work,
        env: { PATH: process.env.PATH ?? '', HOME: work },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const lines: string[] = [];
    let buffer = '';
    const done = new Promise<void>((resolveDone, rejectDone) => {
      const timer = setTimeout(() => rejectDone(new Error('no reply')), 20_000);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        lines.push(...parts.filter(Boolean));
        if (lines.some((line) => line.includes('"id":2'))) {
          clearTimeout(timer);
          resolveDone();
        }
      });
    });
    for (const message of [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    try {
      await done;
    } finally {
      child.kill();
    }
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Every stdout line is a JSON-RPC message; the CLI's own notices go to stderr.
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe('2.0');
  });

  it('refuses unknown plans, tools and bad input without crashing', async () => {
    expect(
      (await call('get_plan', { planId: 'plan-zzz' })).data.error.code,
    ).toBe('not_found');
    const bad = await client.callTool({ name: 'run_commands', arguments: {} });
    expect(bad.isError).toBe(true);
    const unknown = await client.callTool({ name: 'nope', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect((await call('list_cookbooks')).data.ok).toBe(true);
  });
});

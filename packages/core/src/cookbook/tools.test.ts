import { randomUUID } from 'node:crypto';
import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalTool } from '../../../agents/src/invoke-agent.js';
import {
  createSqliteOwnerApprovalStore,
  OwnerApprovalAuthority,
} from '../../../app-runtime/src/owner-approvals.js';
import { createActivationCoordinator } from '../activation.js';
import { SmrtCollection } from '../collection.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import {
  createCookbookRuntimeExposure,
  notifyRuntimeExposureChanged,
  setRuntimeExposureGate,
} from '../runtime-exposure.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { type CookbookEngine, createCookbookEngine } from './engine/engine.js';
import type { EngineState } from './engine/types.js';
import {
  BUNDLED_COOKBOOK_TEMPLATES,
  COOKBOOK_TOOL_NAMES,
  type CookbookToolContext,
  type CookbookToolName,
  type CookbookToolOptions,
  type CookbookToolService,
  createCookbookToolService,
  setCookbookToolService,
} from './tools.js';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';

const CUSTOMER = '@fixture/customers:Customer';
const INVOICE = '@fixture/billing:Invoice';
const catalog: CookbookToolOptions['catalog'] = {
  models: [
    { id: CUSTOMER, name: 'Customer', packageId: 'customers', exposed: true },
    {
      id: INVOICE,
      name: 'Invoice',
      packageId: 'billing',
      exposed: true,
      fields: [{ name: 'currency', default: 'CAD' }],
    },
  ],
  recipes: [
    {
      id: 'customers',
      label: 'Customers',
      summary: 'Keep client details.',
      models: [CUSTOMER],
      nav: [{ model: CUSTOMER, label: 'Customers' }],
      requires: [],
    },
    {
      id: 'billing',
      label: 'Billing',
      summary: 'Create invoices.',
      synonyms: ['payments'],
      intents: ['send invoices and collect money'],
      models: [INVOICE],
      nav: [{ model: INVOICE, label: 'Invoices' }],
      requires: ['customers'],
    },
  ],
  cookbooks: [
    {
      id: 'small-shop',
      name: 'Small Shop',
      document: {
        $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
        version: 1,
        recipes: ['billing'],
        features: [],
        policies: [],
      },
    },
  ],
};
let db: DatabaseInterface;
let service: CookbookToolService;
let authority: OwnerApprovalAuthority;
let engines: Map<string, CookbookEngine>;
let context: CookbookToolContext;
let enabled: boolean;
let readable: boolean;
let permission: boolean;
let owner: boolean;
let failCommit: boolean;
let gate: ReturnType<typeof createCookbookRuntimeExposure>;
let restore: () => void;
let options: CookbookToolOptions;

beforeEach(async () => {
  restore = snapshotObjectRegistryState();
  class Customer extends SmrtObject {
    title = '';
  }
  class Invoice extends SmrtObject {
    currency = 'CAD';
  }
  class Customers extends SmrtCollection<Customer> {
    static readonly _itemClass = Customer;
  }
  class Invoices extends SmrtCollection<Invoice> {
    static readonly _itemClass = Invoice;
  }
  ObjectRegistry.register(Customer, {
    packageName: '@fixture/customers',
    tableName: 'c5_customers',
    api: { public: true },
    mcp: { include: ['list', 'get'] },
  });
  ObjectRegistry.register(Invoice, {
    packageName: '@fixture/billing',
    tableName: 'c5_invoices',
    api: { public: true },
    mcp: { include: ['list', 'get'] },
  });
  ObjectRegistry.registerCollection(CUSTOMER, Customers);
  ObjectRegistry.registerCollection(INVOICE, Invoices);
  db = await getTestDatabase({
    type: databaseType,
    url: ':memory:',
    classes: [
      CUSTOMER,
      INVOICE,
      '@happyvertical/smrt-approvals:ApprovalRequest',
      '@happyvertical/smrt-approvals:ApprovalEvent',
      '@happyvertical/smrt-approvals:ApprovalPolicy',
    ],
  });
  context = { tenantId: randomUUID(), userId: randomUUID(), surface: 'mcp' };
  enabled = readable = permission = owner = true;
  failCommit = false;
  engines = new Map([[context.tenantId!, createCookbookEngine({ catalog })]]);
  await db.query(
    'CREATE TABLE fixture_cookbooks (tenant TEXT PRIMARY KEY, state TEXT NOT NULL)',
  );
  await db.query(
    'CREATE TABLE fixture_cookbook_audit (tenant TEXT, tool TEXT, outcome TEXT)',
  );
  await db.query(
    'INSERT INTO fixture_cookbooks VALUES (?, ?)',
    context.tenantId!,
    JSON.stringify(engines.get(context.tenantId!)!.state()),
  );
  authority = new OwnerApprovalAuthority(
    await createSqliteOwnerApprovalStore(db),
    async (actor) =>
      owner &&
      actor.id === context.userId &&
      actor.tenantId === context.tenantId,
  );
  options = {
    catalog,
    engineFor: (c) => (readable ? engines.get(c.tenantId ?? '') : null),
    isOwner: async (c) =>
      owner && c.userId === context.userId && c.tenantId === context.tenantId,
    can: async () => permission,
    approvals: authority,
    isAppEmpty: async () => true,
    audit: async (event) => {
      await db.query(
        'INSERT INTO fixture_cookbook_audit VALUES (?, ?, ?)',
        event.context.tenantId ?? '',
        event.tool,
        event.outcome,
      );
    },
    commit: async (change) => {
      const before = JSON.stringify(change.before);
      const after = JSON.stringify(change.after);
      if (!db.transaction) throw new Error('SQLite needs transactions');
      await db.transaction(async (tx) => {
        const rows = await tx.query(
          'UPDATE fixture_cookbooks SET state = ? WHERE tenant = ? AND state = ? RETURNING tenant',
          after,
          change.context.tenantId!,
          before,
        );
        if (!rows.rows.length) throw new Error('CAS conflict');
        if (failCommit) throw new Error('storage failure');
        await tx.query(
          'INSERT INTO fixture_cookbook_audit VALUES (?, ?, ?)',
          change.context.tenantId!,
          change.audit.tool,
          change.audit.outcome,
        );
      });
      engines.set(
        change.context.tenantId!,
        createCookbookEngine({ catalog, state: change.after }),
      );
    },
  };
  service = createCookbookToolService(options);
  setCookbookToolService(service);
  gate = createCookbookRuntimeExposure({
    catalog,
    engineFor: (c) => (readable ? engines.get(c.tenantId ?? '') : null),
    predicate: () => enabled,
  });
  setRuntimeExposureGate(gate);
});
afterEach(async () => {
  setCookbookToolService(undefined);
  setRuntimeExposureGate(undefined);
  gate?.dispose();
  await db?.close?.();
  restore();
});
const call = (
  name: Parameters<CookbookToolService['invoke']>[0],
  args: Record<string, unknown> = {},
  c = context,
) => service.invoke(name, args, c);
const revision = () => engines.get(context.tenantId!)!.snapshot().revision;
const enable = () =>
  call('recipes.enable', { id: 'billing', expectedRevision: revision() });
const mcp = () =>
  new MCPGenerator(
    { classNames: [CUSTOMER, INVOICE] },
    { db, tenantId: context.tenantId!, user: { id: context.userId! } },
  );
const request = () => new Request('http://fixture/api/invoices');
const rest = () =>
  new APIGenerator(
    { basePath: '/api' },
    { db, tenantId: context.tenantId! },
  ).generateHandler();

/** Exercise tools against absent application tables, using the normal registry schemas. */
async function lazy() {
  await db.query('DROP TABLE c5_invoices');
  await db.query('DROP TABLE c5_customers');
  const activation = createActivationCoordinator({
    scope: randomUUID(),
    db,
    packageName: '@fixture/tools',
    manifest: {
      version: 1,
      modules: {
        customers: {
          specifier: 'customers',
          models: [CUSTOMER],
          dependencies: [],
        },
        billing: {
          specifier: 'billing',
          models: [INVOICE],
          dependencies: ['customers'],
        },
      },
      models: {
        [CUSTOMER]: {
          module: 'customers',
          effective: CUSTOMER,
          table: 'c5_customers',
          dependencies: [],
        },
        [INVOICE]: {
          module: 'billing',
          effective: INVOICE,
          table: 'c5_invoices',
          dependencies: [CUSTOMER],
        },
      },
      tables: {
        c5_customers: { owners: [CUSTOMER], dependencies: [] },
        c5_invoices: { owners: [INVOICE], dependencies: ['c5_customers'] },
      },
    },
    // Constructors belong to this existing fixture; the independent activation
    // suite verifies deferred imports/registration. Here DDL/readiness is lazy.
    loaders: { customers: async () => {}, billing: async () => {} },
    readEnabled: async () => [],
  });
  options.activation = activation;
  setRuntimeExposureGate(activation.gate(gate));
  await activation.boot();
  return activation;
}

describe(`installed recipe server tools (${databaseType}, in process)`, () => {
  it('activates installed recipes beside editor-owned lists, while refusing other unknown identities', async () => {
    const activation = await lazy();
    const custom = '@fixture/app:LoanerMat';
    const before = engines.get(context.tenantId!)!.state();
    const document: Cookbook = {
      ...before.cookbook,
      features: [custom],
      models: {
        version: 1,
        packageName: '@fixture/app',
        fields: {},
        lists: {
          LoanerMat: {
            label: 'Loaner mats',
            icon: 'layers',
            displayField: 'size',
            fields: { size: { type: 'text' } },
          },
        },
      },
    };
    const after = createCookbookEngine({ catalog, cookbook: document }).state();
    after.revision = before.revision + 1;
    await options.commit({
      context,
      before,
      after,
      audit: {
        context,
        tool: 'cookbook.apply',
        outcome: 'changed',
        summary: 'Fixture app model document',
      },
    });
    expect((await enable()).status).toBe('ok');
    expect(activation.isReady(INVOICE)).toBe(true);
    expect((await rest()(request())).status).toBe(200);
    expect(engines.get(context.tenantId!)!.cookbook().features).toContain(
      custom,
    );
    const current = engines.get(context.tenantId!)!.state();
    const unknown = structuredClone(current);
    unknown.revision++;
    unknown.cookbook.features.push('@fixture/missing:Unknown');
    await options.commit({
      context,
      before: current,
      after: unknown,
      audit: {
        context,
        tool: 'cookbook.apply',
        outcome: 'changed',
        summary: 'Fixture unknown identity',
      },
    });
    await expect(enable()).rejects.toMatchObject({ code: 'activation_failed' });
  });

  it('reads ownership and permissions once per listing, and keeps the per-tool fallback', async () => {
    const all = (await service.list(context)).map((tool) => tool.name);
    expect(all.length).toBeGreaterThan(1);
    let owners = 0;
    let singles = 0;
    const batches: string[][] = [];
    const counted = {
      ...options,
      isOwner: async (c: CookbookToolContext) => {
        owners++;
        return options.isOwner(c);
      },
      can: async () => {
        singles++;
        return permission;
      },
    };
    const batched = createCookbookToolService({
      ...counted,
      canAll: async (_c, tools) => {
        batches.push([...tools]);
        return new Set(tools.filter((tool) => tool !== all[0]));
      },
    });
    expect((await batched.list(context)).map((tool) => tool.name)).toEqual(
      all.slice(1),
    );
    expect({ owners, singles, batches }).toEqual({
      owners: 1,
      singles: 0,
      batches: [all],
    });
    const failing = createCookbookToolService({
      ...counted,
      canAll: async () => {
        throw new Error('permission store unreadable');
      },
    });
    expect(await failing.list(context)).toEqual([]);
    owners = 0;
    const single = createCookbookToolService(counted);
    expect((await single.list(context)).map((tool) => tool.name)).toEqual(all);
    expect({ owners, singles }).toEqual({ owners: 1, singles: all.length });
  });

  it('lists nothing when canAll grants no tools', async () => {
    expect((await service.list(context)).length).toBeGreaterThan(0);
    const canAll = vi.fn(async () => new Set<CookbookToolName>());
    const can = vi.fn(options.can);
    const denied = createCookbookToolService({ ...options, can, canAll });
    await expect(denied.list(context)).resolves.toEqual([]);
    expect(canAll).toHaveBeenCalledTimes(1);
    expect(can).not.toHaveBeenCalled();
  });

  it('lists nothing for a non-owner without calling canAll', async () => {
    const isOwner = vi.fn(async () => false);
    const canAll = vi.fn(async () => new Set(COOKBOOK_TOOL_NAMES));
    const can = vi.fn(options.can);
    const denied = createCookbookToolService({
      ...options,
      isOwner,
      can,
      canAll,
    });
    await expect(denied.list(context)).resolves.toEqual([]);
    expect(isOwner).toHaveBeenCalledTimes(1);
    expect(canAll).not.toHaveBeenCalled();
    expect(can).not.toHaveBeenCalled();
  });

  it('fails the whole listing closed when fallback can throws synchronously', async () => {
    const all = (await service.list(context)).map((tool) => tool.name);
    expect(all.length).toBeGreaterThan(1);
    const can = vi.fn<CookbookToolOptions['can']>((_context, name) => {
      if (name === all[1]) throw new Error('permission store unreadable');
      return Promise.resolve(true);
    });
    const denied = createCookbookToolService({ ...options, can });
    await expect(denied.list(context)).resolves.toEqual([]);
    expect(can).toHaveBeenCalledTimes(2);
    expect(can).toHaveBeenLastCalledWith(context, all[1]);
  });

  it('activates a lazy closure before publishing enablement, then honors preference and durable disable approval', async () => {
    const activation = await lazy();
    const handler = rest();
    expect(await service.list(context)).toHaveLength(7); // Empty lazy host can bootstrap.
    expect((await handler(request())).status).toBe(404);
    expect(activation.isReady(INVOICE)).toBe(false);
    const result = await mcp().handleToolCall({
      method: 'tools/call',
      params: {
        name: 'recipes.enable',
        arguments: { id: 'billing', expectedRevision: 0 },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(activation.isReady(CUSTOMER)).toBe(true);
    expect(activation.isReady(INVOICE)).toBe(true);
    expect((await handler(request())).status).toBe(200);
    enabled = false;
    notifyRuntimeExposureChanged();
    expect((await handler(request())).status).toBe(404);
    expect(await service.list(context)).toEqual([]);
    enabled = true;
    const args = { id: 'billing', expectedRevision: revision() };
    const hold = await call('recipes.disable', args);
    authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      async () => true,
    );
    options.approvals = authority;
    await authority.decide(
      { id: context.userId!, tenantId: context.tenantId! },
      String(hold.approvalId),
      true,
    );
    await call('recipes.disable', { ...args, approvalId: hold.approvalId });
    expect((await handler(request())).status).toBe(404);
    expect(activation.isReady(INVOICE)).toBe(true);
    expect(
      await authority.get(context.tenantId!, String(hold.approvalId)),
    ).toMatchObject({ status: 'succeeded' });
    expect(
      (
        await db.query(
          databaseType === 'pglite'
            ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'c5_invoices'"
            : "SELECT name FROM sqlite_master WHERE name = 'c5_invoices'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('reports lazy migration failure to the tool caller without persisting enablement, and permits retry', async () => {
    const activation = await lazy();
    const handler = rest();
    if (!db.transaction) throw new Error('SQLite transaction required');
    const failure = vi
      .spyOn(
        db,
        databaseType === 'pglite' && db.beginTransaction
          ? 'beginTransaction'
          : 'transaction',
      )
      .mockImplementation(async () => {
        throw new Error('injected activation DDL failure');
      });
    await expect(enable()).rejects.toMatchObject({
      code: 'activation_failed',
      publicMessage: expect.stringContaining('injected activation DDL failure'),
    });
    const refused = await mcp().handleToolCall({
      method: 'tools/call',
      params: {
        name: 'recipes.enable',
        arguments: { id: 'billing', expectedRevision: 0 },
      },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      'Recipe activation failed; cookbook unchanged',
    );
    expect(revision()).toBe(0);
    expect(activation.isReady(INVOICE)).toBe(false);
    expect((await handler(request())).status).toBe(404);
    failure.mockRestore();
    failCommit = true;
    await expect(enable()).rejects.toThrow('storage failure');
    expect(activation.isReady(INVOICE)).toBe(true);
    expect(revision()).toBe(0);
    expect((await handler(request())).status).toBe(404);
    failCommit = false;
    await enable();
    expect((await handler(request())).status).toBe(200);
    failure.mockRestore();
  });

  it('activates templates only after approval and rechecks preference after activation awaits', async () => {
    const activation = await lazy();
    options.isAppEmpty = async () => false;
    const preview = await call('cookbook.apply', { id: 'small-shop' });
    const args = {
      id: 'small-shop',
      apply: true,
      expectedRevision: 0,
      previewToken: preview.previewToken,
    };
    const hold = await call('cookbook.apply', args);
    expect(activation.isReady(INVOICE)).toBe(false);
    await authority.decide(
      { id: context.userId!, tenantId: context.tenantId! },
      String(hold.approvalId),
      true,
    );
    const activate = activation.activate.bind(activation);
    const change = vi
      .spyOn(activation, 'activate')
      .mockImplementation(async (models) => {
        await activate(models);
        enabled = false;
      });
    await expect(
      call('cookbook.apply', { ...args, approvalId: hold.approvalId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(revision()).toBe(0);
    expect(activation.isReady(INVOICE)).toBe(true);
    expect((await rest()(request())).status).toBe(404);
    expect(
      await authority.get(context.tenantId!, String(hold.approvalId)),
    ).toMatchObject({ status: 'failed' });
    change.mockRestore();
  });
  it('finds intent words and describes human additions, dependency and enabled state', async () => {
    const result = await call('recipes.search', {
      query: 'collect money',
    });
    expect(result.recipes).toHaveLength(1);
    expect(result.recipes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'billing',
          enabled: false,
          requires: ['customers'],
          adds: [expect.objectContaining({ label: 'Invoices' })],
        }),
      ]),
    );
    expect(await call('recipes.describe', { id: 'billing' })).toMatchObject({
      recipe: { enabled: false, revision: 0 },
    });
    await enable();
    expect(await call('recipes.describe', { id: 'billing' })).toMatchObject({
      recipe: { enabled: true },
    });
  });

  it('enables REST and generated model tools with dependencies, no rebuild; disables only after durable approval', async () => {
    const handler = rest();
    const generator = mcp();
    const superset = await generator.generateToolDefinitions();
    const changed = vi.fn();
    const unsubscribe = generator.onToolsListChanged(changed);
    expect((await handler(request())).status).toBe(404);
    expect((await generator.generateTools()).map((t) => t.name)).toEqual([
      ...COOKBOOK_TOOL_NAMES.filter((name) => !name.startsWith('app.')),
    ]);
    const enabledResult = await generator.handleToolCall({
      method: 'tools/call',
      params: {
        name: 'recipes.enable',
        arguments: { id: 'billing', expectedRevision: 0 },
      },
    });
    expect(enabledResult.isError).not.toBe(true);
    expect(engines.get(context.tenantId!)!.cookbook().recipes).toEqual([
      'billing',
      'customers',
    ]);
    expect((await handler(request())).status).toBe(200);
    expect((await generator.generateTools()).map((t) => t.name)).toContain(
      'invoice_list',
    );
    const args = { id: 'billing', expectedRevision: revision() };
    const hold = await call('recipes.disable', args);
    expect(hold.status).toBe('approval_required');
    expect((await handler(request())).status).toBe(200);
    // Reopen the durable authority, decide in the owner UI, then resume the saved call.
    authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      async () => true,
    );
    options.approvals = authority;
    await authority.decide(
      { id: context.userId!, tenantId: context.tenantId! },
      String(hold.approvalId),
      true,
    );
    await call('recipes.disable', { ...args, approvalId: hold.approvalId });
    expect((await handler(request())).status).toBe(404);
    expect((await generator.generateTools()).map((t) => t.name)).not.toContain(
      'invoice_list',
    );
    expect(
      await authority.get(context.tenantId!, String(hold.approvalId)),
    ).toMatchObject({ status: 'succeeded' });
    await expect(
      call('recipes.disable', { ...args, approvalId: hold.approvalId }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await generator.generateToolDefinitions()).toEqual(superset);
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it('retains required dependencies and rejects changed arguments, cross-tenant approvals and stale revisions', async () => {
    await enable();
    const args = { id: 'customers', expectedRevision: revision() };
    const hold = await call('recipes.disable', args);
    await authority.decide(
      { id: context.userId!, tenantId: context.tenantId! },
      String(hold.approvalId),
      true,
    );
    await expect(
      call('recipes.disable', {
        ...args,
        id: 'billing',
        approvalId: hold.approvalId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(
        'recipes.disable',
        { ...args, approvalId: hold.approvalId },
        { ...context, tenantId: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const other = { ...context, tenantId: randomUUID() };
    const state = engines.get(context.tenantId!)!.state();
    engines.set(other.tenantId!, createCookbookEngine({ catalog, state }));
    await db.query(
      'INSERT INTO fixture_cookbooks VALUES (?, ?)',
      other.tenantId!,
      JSON.stringify(state),
    );
    options.isOwner = async (c) => c.userId === context.userId;
    await expect(
      call('recipes.disable', { ...args, approvalId: hold.approvalId }, other),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(engines.get(other.tenantId!)!.state()).toEqual(state);
    await call('recipes.disable', { ...args, approvalId: hold.approvalId });
    expect(engines.get(context.tenantId!)!.cookbook().recipes).toEqual([
      'billing',
      'customers',
    ]);
    await expect(
      call('recipes.enable', { id: 'billing', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('configures existing policies and navigation overrides atomically; refuses another recipe and malformed icons', async () => {
    await enable();
    await call('recipes.configure', {
      id: 'billing',
      expectedRevision: revision(),
      fields: [
        {
          model: INVOICE,
          field: 'currency',
          visibility: 'hidden',
          label: 'Money',
          defaultValue: 'USD',
        },
      ],
      items: [{ id: 'item:billing:Invoice', label: 'Bills', icon: 'receipt' }],
    });
    const snapshot = engines.get(context.tenantId!)!.snapshot();
    expect(snapshot.policies).toBe(1);
    expect(snapshot.sections.flatMap((s) => s.items)).toContainEqual(
      expect.objectContaining({ label: 'Bills', icon: 'receipt' }),
    );
    const before = engines.get(context.tenantId!)!.state();
    expect(before.cookbook.policies).toEqual([
      expect.objectContaining({
        objectRef: INVOICE,
        fieldName: 'currency',
        visibility: 'hidden',
        label: 'Money',
        defaultValue: '"USD"',
      }),
    ]);
    await expect(
      call('recipes.configure', {
        id: 'billing',
        expectedRevision: revision(),
        fields: [{ model: CUSTOMER, field: 'name', label: 'Secret' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      call('recipes.configure', {
        id: 'billing',
        expectedRevision: revision(),
        items: [{ id: 'item:billing:Invoice', icon: '<svg>' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      call('recipes.configure', {
        id: 'billing',
        expectedRevision: revision(),
        fields: [
          { model: INVOICE, field: 'currency', label: 'Changed' },
          { model: INVOICE, field: 'absent', label: 'Bad' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'batch_failed' });
    expect(engines.get(context.tenantId!)!.state()).toEqual(before);
  });

  it('allows owner preview preference off while retaining revision and destructive holds', async () => {
    options.previewBeforeApply = () => false;
    const definitions = await service.list(context);
    expect(
      definitions.find((tool) => tool.name === 'recipes.enable')?.annotations
        .workProfile,
    ).toBe('design');
    expect(
      definitions.find((tool) => tool.name === 'app.describe')?.annotations
        .workProfile,
    ).toBeUndefined();
    await expect(
      call('cookbook.apply', { id: 'small-shop' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    context.initialSetup = true;
    expect(
      (
        await call('cookbook.apply', {
          id: 'small-shop',
          expectedRevision: revision(),
        })
      ).status,
    ).toBe('ok');
    context.initialSetup = false;
    options.isAppEmpty = async () => false;
    expect(
      (
        await call('cookbook.apply', {
          id: 'small-shop',
          expectedRevision: revision(),
        })
      ).status,
    ).toBe('approval_required');
  });
  it('allows only trusted initial setup to replace an empty configured app without an extra hold', async () => {
    await enable();
    expect(
      (await call('cookbook.apply', { id: 'small-shop' })).approvalRequired,
    ).toBe(true);
    await expect(
      call('cookbook.apply', { id: 'small-shop', initialSetup: true }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    context.initialSetup = true;
    const preview = await call('cookbook.apply', { id: 'small-shop' });
    expect(preview.approvalRequired).toBe(false);
    expect(preview.summary).not.toMatch(/set up|completed/i);
    expect(
      (
        await call('cookbook.apply', {
          id: 'small-shop',
          apply: true,
          expectedRevision: revision(),
          previewToken: preview.previewToken,
        })
      ).status,
    ).toBe('ok');
    options.isAppEmpty = async () => false;
    expect(
      (await call('cookbook.apply', { id: 'small-shop' })).approvalRequired,
    ).toBe(true);
  });
  it('refuses the empty-app shortcut if records arrive while lazy activation is awaited', async () => {
    const activation = await lazy();
    const activate = activation.activate.bind(activation);
    let empty = true;
    options.isAppEmpty = async () => empty;
    context.initialSetup = true;
    const preview = await call('cookbook.apply', { id: 'small-shop' });
    vi.spyOn(activation, 'activate').mockImplementation(async (models) => {
      await activate(models);
      empty = false;
    });
    await expect(
      call('cookbook.apply', {
        id: 'small-shop',
        apply: true,
        expectedRevision: 0,
        previewToken: preview.previewToken,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(revision()).toBe(0);
  });
  it('rechecks live exposure after the host empty-data check before committing', async () => {
    const activation = await lazy();
    const activate = activation.activate.bind(activation);
    let activated = false;
    vi.spyOn(activation, 'activate').mockImplementation(async (models) => {
      await activate(models);
      activated = true;
    });
    context.initialSetup = true;
    options.isAppEmpty = async () => {
      if (activated) enabled = false;
      return true;
    };
    const preview = await call('cookbook.apply', { id: 'small-shop' });
    await expect(
      call('cookbook.apply', {
        id: 'small-shop',
        apply: true,
        expectedRevision: 0,
        previewToken: preview.previewToken,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(revision()).toBe(0);
  });
  it('previews templates without effects; binds apply to actor/revision and requires approval on non-empty apps', async () => {
    expect(await call('cookbook.listTemplates')).toMatchObject({
      templates: [
        {
          id: 'small-shop',
          missing: [],
          description: expect.any(String),
          lists: expect.arrayContaining(['Invoices']),
        },
      ],
    });
    const preview = await call('cookbook.apply', { id: 'small-shop' });
    expect(preview).toMatchObject({
      status: 'preview',
      revision: 0,
      diff: { added: ['billing', 'customers'] },
    });
    expect(revision()).toBe(0);
    await expect(
      call('cookbook.apply', {
        id: 'small-shop',
        apply: true,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await call('cookbook.apply', {
      id: 'small-shop',
      apply: true,
      expectedRevision: 0,
      previewToken: preview.previewToken,
    });
    const next = await call('cookbook.apply', { id: 'small-shop' });
    const args = {
      id: 'small-shop',
      apply: true,
      expectedRevision: revision(),
      previewToken: next.previewToken,
    };
    const hold = await call('cookbook.apply', args);
    expect(hold.status).toBe('approval_required');
    await authority.decide(
      { id: context.userId!, tenantId: context.tenantId! },
      String(hold.approvalId),
      true,
    );
    // Restart the tool service: the durable hold restores its pinned preview.
    service = createCookbookToolService(options);
    await call('cookbook.apply', { ...args, approvalId: hold.approvalId });
    expect(BUNDLED_COOKBOOK_TEMPLATES.map((t) => t.id)).toEqual([
      'bakery',
      'mechanic',
      'welder',
      'yoga-studio',
    ]);
  });

  it('publishes raw screen policies only after the matching durable cookbook approval is consumed', async () => {
    await enable();
    const document: Cookbook = {
      ...catalog.cookbooks![0].document,
      policies: [
        {
          objectRef: INVOICE,
          fieldName: 'currency',
          scopeType: 'app',
          defaultValue: '"USD"',
          visibility: 'hidden',
          readOnly: true,
          label: 'Billing currency',
        },
      ],
    };
    options.catalog = {
      ...catalog,
      cookbooks: [{ id: 'policy-shop', name: 'Policy Shop', document }],
    };
    service = createCookbookToolService(options);
    const before = engines.get(context.tenantId!)!.cookbook();
    const preview = await call('cookbook.apply', { id: 'policy-shop' });
    const args = {
      id: 'policy-shop',
      apply: true,
      expectedRevision: revision(),
      previewToken: preview.previewToken,
    };
    const hold = await call('cookbook.apply', args);
    expect(hold.status).toBe('approval_required');
    expect(engines.get(context.tenantId!)!.cookbook()).toEqual(before);
    // Client-provided record readOnly/approved flags do not authorize the replacement.
    await expect(
      call('cookbook.apply', {
        ...args,
        approvalId: hold.approvalId,
        approved: true,
      }),
    ).rejects.toBeDefined();
    expect(engines.get(context.tenantId!)!.cookbook()).toEqual(before);
    await authority.decide(
      { id: context.userId!, tenantId: context.tenantId! },
      String(hold.approvalId),
      true,
    );
    await call('cookbook.apply', { ...args, approvalId: hold.approvalId });
    expect(engines.get(context.tenantId!)!.cookbook().policies).toEqual(
      document.policies,
    );
    expect(
      await authority.get(context.tenantId!, String(hold.approvalId)),
    ).toMatchObject({ status: 'succeeded' });
    await expect(
      call('cookbook.apply', { ...args, approvalId: hold.approvalId }),
    ).rejects.toBeDefined();
  });

  it('removes every tool when the preference is off and refuses retained MCP/assistant tools and non-owners', async () => {
    const generator = mcp();
    const assistant = await service.assistantTools({
      ...context,
      surface: 'assistant',
    });
    const contract: PrincipalTool[] = assistant;
    expect(contract.map((t) => t.slug)).toEqual([
      ...COOKBOOK_TOOL_NAMES.filter((name) => !name.startsWith('app.')),
    ]);
    const changed = vi.fn();
    const unsubscribe = generator.onToolsListChanged(changed);
    enabled = false;
    notifyRuntimeExposureChanged();
    expect(await generator.generateTools()).toEqual([]);
    expect(await service.assistantTools(context)).toEqual([]);
    const retained = assistant[0];
    await expect(
      retained.execute({
        run: {
          context: { tenantId: context.tenantId!, userId: context.userId! },
          assertToolAllowed() {},
          async assertOperation() {},
        },
        args: { query: 'money' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      (
        await generator.handleToolCall({
          method: 'tools/call',
          params: {
            name: 'recipes.enable',
            arguments: { id: 'billing', expectedRevision: 0 },
          },
        })
      ).isError,
    ).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    enabled = true;
    owner = false;
    expect(await service.list(context)).toEqual([]);
    await expect(enable()).rejects.toMatchObject({ code: 'forbidden' });
    owner = true;
    permission = false;
    expect(await service.list(context)).toEqual([]);
    permission = true;
    readable = false;
    expect(await service.list(context)).toEqual([]);
    readable = true;
    expect(await service.list({ ...context, tenantId: null })).toEqual([]);
    unsubscribe();
  });

  it('rolls back persistence and the live gate on commit/audit failure; checks host enable-approval policy', async () => {
    failCommit = true;
    await expect(enable()).rejects.toThrow('storage failure');
    expect(revision()).toBe(0);
    const stored = (await db.query('SELECT state FROM fixture_cookbooks'))
      .rows[0].state;
    expect((JSON.parse(String(stored)) as EngineState).revision).toBe(0);
    expect((await rest()(request())).status).toBe(404);
    expect(
      (
        await db.query(
          "SELECT * FROM fixture_cookbook_audit WHERE outcome = 'changed'",
        )
      ).rows,
    ).toEqual([]);
    failCommit = false;
    options.requiresApproval = (name) => name === 'recipes.enable';
    expect((await enable()).status).toBe('approval_required');
    expect(revision()).toBe(0);
  });
  it('rejects unknown inputs and stale previews, and rechecks preference after an approved hold', async () => {
    await expect(
      call('recipes.describe', { id: 'absent' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call('recipes.search', { query: 'money', tenantId: 'forged' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    options.isAppEmpty = async () => false;
    const preview = await call('cookbook.apply', { id: 'small-shop' });
    expect(preview.approvalRequired).toBe(true);
    options.isAppEmpty = async () => true;
    await enable();
    await expect(
      call('cookbook.apply', {
        id: 'small-shop',
        apply: true,
        expectedRevision: 0,
        previewToken: preview.previewToken,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const args = { id: 'billing', expectedRevision: revision() };
    const hold = await call('recipes.disable', args);
    await authority.decide(
      { id: context.userId!, tenantId: context.tenantId! },
      String(hold.approvalId),
      true,
    );
    enabled = false;
    await expect(
      call('recipes.disable', { ...args, approvalId: hold.approvalId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    enabled = true;
    expect(engines.get(context.tenantId!)!.cookbook().recipes).toContain(
      'billing',
    );
    const bundled = createCookbookToolService({
      ...options,
      catalog: { ...catalog, cookbooks: undefined },
    });
    expect(
      await bundled.invoke('cookbook.listTemplates', {}, context),
    ).toMatchObject({
      templates: expect.arrayContaining([
        expect.objectContaining({
          id: 'bakery',
          missing: expect.arrayContaining(['commerce.invoicing']),
        }),
      ]),
    });
    await expect(
      bundled.invoke('cookbook.apply', { id: 'bakery' }, context),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});

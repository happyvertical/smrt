import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalTool } from '../../../agents/src/invoke-agent.js';
import {
  createSqliteOwnerApprovalStore,
  OwnerApprovalAuthority,
} from '../../../app-runtime/src/owner-approvals.js';
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
  type CookbookToolOptions,
  type CookbookToolService,
  createCookbookToolService,
  setCookbookToolService,
} from './tools.js';

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
    type: 'sqlite',
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

describe('installed recipe server tools (SQLite, in process)', () => {
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
      ...COOKBOOK_TOOL_NAMES,
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

  it('previews templates without effects; binds apply to actor/revision and requires approval on non-empty apps', async () => {
    expect(await call('cookbook.listTemplates')).toMatchObject({
      templates: [{ id: 'small-shop', missing: [] }],
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
    await call('cookbook.apply', { ...args, approvalId: hold.approvalId });
    expect(BUNDLED_COOKBOOK_TEMPLATES.map((t) => t.id)).toEqual([
      'bakery',
      'mechanic',
      'welder',
      'yoga-studio',
    ]);
  });

  it('removes every tool when the preference is off and refuses retained MCP/assistant tools and non-owners', async () => {
    const generator = mcp();
    const assistant = await service.assistantTools({
      ...context,
      surface: 'assistant',
    });
    const contract: PrincipalTool[] = assistant;
    expect(contract.map((t) => t.slug)).toEqual([...COOKBOOK_TOOL_NAMES]);
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

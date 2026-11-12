/** C6: one tool service, real editor/approvals, SQLite and existing generated transports. */
import { randomUUID } from 'node:crypto';
import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalTool } from '../../../agents/src/invoke-agent.js';
import {
  createSqliteOwnerApprovalStore,
  OwnerApprovalAuthority,
} from '../../../app-runtime/src/owner-approvals.js';
import {
  createAssistantApprovalBridge,
  requiresOwnerApproval,
} from '../../../chat/src/assistant-approvals.js';
import {
  screenRecordLabel,
  screenReferenceTarget,
} from '../../../smrt-svelte/src/components/screens/references.js';
import { createRecipeScreenReferences } from '../../../smrt-svelte/src/components/screens/source.js';
import { withTenant } from '../../../tenancy/src/context.js';
import {
  disableTenancy,
  enableTenancy,
} from '../../../tenancy/src/interceptor.js';
import { createActivationCoordinator } from '../activation.js';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import {
  createCookbookRuntimeExposure,
  setRuntimeExposureGate,
} from '../runtime-exposure.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { describeApp } from './app-tool-edits.js';
import { coveredModels } from './engine/document.js';
import { type CookbookEngine, createCookbookEngine } from './engine/engine.js';
import {
  APP_TOOL_NAMES,
  COOKBOOK_TOOL_NAMES as browserNames,
} from './index.js';
import { createAppModelEditor } from './model-editor.js';
import {
  type CookbookToolContext,
  type CookbookToolName,
  type CookbookToolOptions,
  type CookbookToolService,
  createCookbookToolService,
  setCookbookToolService,
} from './tools.js';

const APP = '@fixture/c6-app';
const CUSTOMER = '@fixture/c6-upstream:Customer';
const TENANT = randomUUID();
const OTHER = randomUUID();
const USER = randomUUID();
const catalog: CookbookToolOptions['catalog'] = {
  models: [
    {
      id: CUSTOMER,
      name: 'Customer',
      packageId: 'c6-upstream',
      exposed: true,
      fields: [{ name: 'name' }],
    },
  ],
  recipes: [
    {
      id: 'customers',
      label: 'Customer records',
      models: [CUSTOMER],
      nav: [{ model: CUSTOMER, label: 'Customers', icon: 'users' }],
      synonyms: ['clients'],
      requires: [],
    },
  ],
};
const initial = (): Cookbook => ({
  $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
  version: 1,
  recipes: ['customers'],
  features: [],
  policies: [],
});
let db: DatabaseInterface;
let editor: Awaited<ReturnType<typeof createAppModelEditor>>;
let engine: CookbookEngine;
let service: CookbookToolService;
let authority: OwnerApprovalAuthority;
let restore: () => void;
let context: CookbookToolContext;
let owner: boolean;
let permission: boolean;
let prebuilt: boolean;
let failAudit: boolean;
let gate: ReturnType<typeof createCookbookRuntimeExposure>;
let options: CookbookToolOptions;
const audit = vi.fn();

beforeEach(async () => {
  restore = snapshotObjectRegistryState();
  globalThis.__smrtModelReadiness?.clear();
  class Customer extends SmrtObject {
    name = '';
  }
  field({ type: 'text' })(Customer.prototype, 'name');
  ObjectRegistry.register(Customer, {
    packageName: '@fixture/c6-upstream',
    tableName: 'c6_customers',
    tenantScoped: true,
    api: true,
    mcp: true,
    display: { label: 'name' },
  });
  enableTenancy();
  db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [
      CUSTOMER,
      '@happyvertical/smrt-approvals:ApprovalRequest',
      '@happyvertical/smrt-approvals:ApprovalEvent',
      '@happyvertical/smrt-approvals:ApprovalPolicy',
    ],
  });
  owner = permission = prebuilt = true;
  failAudit = false;
  context = { tenantId: TENANT, userId: USER, surface: 'mcp' };
  engine = createCookbookEngine({ catalog, cookbook: initial() });
  editor = await createAppModelEditor({
    db,
    application: 'c6',
    tenantId: TENANT,
    packageName: APP,
    cookbook: initial(),
    catalog,
    authorize: (c) => owner && c.tenantId === TENANT && c.actor === USER,
    publish: (snapshot) => {
      engine = createCookbookEngine({
        catalog,
        state: {
          version: 1,
          revision: snapshot.revision,
          applied: null,
          cookbook: snapshot.cookbook,
          journal: [],
        },
      });
    },
  });
  authority = new OwnerApprovalAuthority(
    await createSqliteOwnerApprovalStore(db),
    async () => owner,
  );
  audit.mockReset();
  options = {
    catalog,
    modelEditorFor: (c) => (c.tenantId === TENANT ? editor : null),
    engineFor: (c) => (c.tenantId === TENANT ? engine : null),
    isOwner: async (c) => owner && c.userId === USER,
    can: async () => permission,
    approvals: authority,
    isAppEmpty: async () => true,
    commit: async () => {
      throw new Error('Editor must own all cookbook writes');
    },
    audit: async (event) => {
      if (failAudit) throw new Error('audit unavailable');
      audit(event);
    },
  };
  service = createCookbookToolService(options);
  setCookbookToolService(service);
  gate = createCookbookRuntimeExposure({
    catalog,
    engineFor: (c) => (c.tenantId === TENANT ? engine : null),
    predicate: (model) =>
      prebuilt ||
      !!engine.cookbook().models?.lists[
        model.qualifiedName?.startsWith(`${APP}:`)
          ? model.qualifiedName.split(':').at(-1)!
          : ''
      ],
  });
  setRuntimeExposureGate(gate);
});
afterEach(async () => {
  setCookbookToolService(undefined);
  setRuntimeExposureGate(undefined);
  gate?.dispose();
  globalThis.__smrtModelReadiness?.clear();
  disableTenancy();
  await db?.close?.();
  restore();
});
const call = (
  name: CookbookToolName,
  args: Record<string, unknown> = {},
  caller = context,
) => service.invoke(name, args, caller);
const write = (name: CookbookToolName, args: Record<string, unknown> = {}) =>
  call(name, { ...args, expectedRevision: editor.snapshot().revision });
const mcp = () =>
  new MCPGenerator(
    { classNames: [CUSTOMER] },
    { db, tenantId: TENANT, user: { id: USER } },
  );
async function approve(name: CookbookToolName, args: Record<string, unknown>) {
  const bound = { ...args, expectedRevision: editor.snapshot().revision };
  const hold = await call(name, bound);
  expect(hold.status).toBe('approval_required');
  // Reopen authority against the durable SQLite ledger, as a process restart would.
  authority = new OwnerApprovalAuthority(
    await createSqliteOwnerApprovalStore(db),
    async () => owner,
  );
  options.approvals = authority;
  await authority.decide(
    { id: USER, tenantId: TENANT },
    String(hold.approvalId),
    true,
  );
  return call(name, { ...bound, approvalId: hold.approvalId });
}
const lists = async () =>
  (await call('app.describe')).lists as {
    id: string;
    label: string;
    origin: string;
    fields: { name: string; label: string; hidden: boolean; type: string }[];
  }[];
const request = (method: string, path: string, data?: unknown) =>
  new Request(`http://fixture/api/${path}`, {
    method,
    ...(data
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        }
      : {}),
  });
const rest = (req: Request) =>
  withTenant({ tenantId: TENANT }, () =>
    new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (r) => r },
      { db, tenantId: TENANT },
    ).generateHandler()(req),
  );

describe('app customization tools', () => {
  it('keeps prerequisite models active without inventing assistant list names', async () => {
    const prerequisite = '@fixture/c6-upstream:Profile';
    const source = {
      ...catalog,
      models: [
        ...catalog.models,
        {
          id: prerequisite,
          name: 'Profile',
          packageId: 'c6-upstream',
          exposed: true,
        },
      ],
      recipes: [
        ...catalog.recipes,
        {
          id: 'identity',
          label: 'Identity',
          models: [prerequisite],
          nav: [],
          requires: [],
        },
      ],
    };
    const doc = { ...initial(), recipes: ['customers', 'identity'] };
    const snapshot = { ...editor.snapshot(), cookbook: doc };
    expect(coveredModels(source, doc).has(prerequisite)).toBe(true);
    expect(describeApp(snapshot, source).map((list) => list.label)).toEqual([
      'Customers',
    ]);
    // Explicit cookbook placement restores the prerequisite as an editable list.
    expect(
      describeApp(
        { ...snapshot, cookbook: { ...doc, features: [prerequisite] } },
        source,
      ).map((list) => list.label),
    ).toEqual(['Customers', 'Profile']);
  });

  it('describes cookbook labels, ownership and synonyms without needing class names', async () => {
    expect(await lists()).toMatchObject([
      {
        label: 'Customers',
        origin: 'pre-built',
        fields: expect.arrayContaining([
          {
            name: 'name',
            label: 'Name',
            type: 'text',
            origin: 'pre-built',
            hidden: false,
          },
        ]),
      },
    ]);
    const result = await write('app.addField', {
      list: 'the clients list',
      label: 'Favourite colour',
      kind: 'text',
    });
    expect(result).toMatchObject({
      status: 'ok',
      data: { field: 'favouriteColour' },
    });
    expect((await lists())[0].fields).toContainEqual(
      expect.objectContaining({
        name: 'favouriteColour',
        label: 'Favourite colour',
        origin: 'yours',
      }),
    );
    expect(await editor.history()).toHaveLength(1);
  });

  it.each([
    ['Short note', 'text', {}],
    ['Long note', 'long text', {}],
    ['Rating', 'number', {}],
    ['Fee', 'money', { currency: 'USD' }],
    ['Birthday', 'date', {}],
    ['Next visit', 'date-time', {}],
    ['Paid', 'yes/no', {}],
    ['Level', 'choice', { options: ['new', 'regular'] }],
  ])('adds %s live to REST, MCP and web definitions', async (label, kind, extras) => {
    const generator = mcp();
    await generator.generateTools();
    const changed = vi.fn();
    const off = generator.onToolsListChanged(changed);
    const result = await write('app.addField', {
      list: 'the customers list',
      label,
      kind,
      ...extras,
    });
    expect(result.status).toBe('ok');
    const name = (result.data as { field: string }).field;
    expect(
      editor.snapshot().webDefinitions.find((d) => d.className === 'Customer')
        ?.fields,
    ).toHaveProperty(name);
    const create = (await generator.generateTools()).find(
      (tool) => tool.name === 'customer_create',
    );
    expect(create?.inputSchema).toHaveProperty(`properties.${name}`);
    expect(changed).toHaveBeenCalled();
    off();
  });

  it('stores money as integer minor units and rejects fractions through the existing REST executor', async () => {
    await write('app.addField', {
      list: 'Customers',
      label: 'Note',
      kind: 'text',
    });
    await write('app.addField', {
      list: 'Customers',
      label: 'Membership fee',
      kind: 'money',
      currency: 'USD',
    });
    const response = await rest(
      request('POST', 'customers', { name: 'Maya', membershipFee: 2500 }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      membershipFee: 2500,
      membershipFeeCurrency: 'USD',
    });
    expect(
      (
        await db.query(
          'SELECT membership_fee, typeof(membership_fee) AS storage FROM c6_customers',
        )
      ).rows[0],
    ).toMatchObject({ membership_fee: 2500, storage: 'integer' });
    expect(
      (
        await rest(
          request('POST', 'customers', { name: 'bad', membershipFee: 2.5 }),
        )
      ).status,
    ).not.toBe(201);
  });

  it('adds a named list, shows linked record names and publishes cookbook navigation', async () => {
    const generator = new MCPGenerator(
      {},
      { db, tenantId: TENANT, user: { id: USER } },
    );
    await generator.generateTools();
    await write('app.addList', {
      label: 'Loaner mats',
      fields: [
        { label: 'Mat name', kind: 'text' },
        { label: 'Condition', kind: 'choice', options: ['new', 'used'] },
      ],
      nameField: 'Mat name',
    });
    const nav = engine.snapshot().sections.flatMap((section) => section.items);
    expect(nav).toContainEqual(
      expect.objectContaining({ label: 'Loaner mats', icon: 'package' }),
    );
    expect(
      (await generator.generateTools()).some(
        (tool) => tool.name === 'loanermats_create',
      ),
    ).toBe(true);
    await write('app.addField', {
      list: 'Customers',
      label: 'Preferred mat',
      kind: 'link',
      linkTo: 'the loaner mats list',
    });
    await withTenant({ tenantId: TENANT }, async () => {
      const mats = await ObjectRegistry.getCollection(`${APP}:LoanerMats`, {
        db,
      });
      const mat = await mats.create({ matName: 'Blue mat', condition: 'new' });
      const customers = await ObjectRegistry.getCollection(CUSTOMER, { db });
      const customer = await customers.create({
        name: 'Maya',
        preferredMat: mat.id,
      });
      expect(
        (await customer.loadRelated('preferredMat'))?.toJSON(),
      ).toMatchObject({ matName: 'Blue mat' });
    });
    const definition = editor
      .snapshot()
      .webDefinitions.find((d) => d.className === 'LoanerMats');
    expect(definition?.displayLabelField).toBe('matName');
    const definitions = editor.snapshot().webDefinitions;
    const sourceDefinition = definitions.find(
      (def) => def.className === 'Customer',
    )!;
    const fetcher: typeof fetch = async (input, init) =>
      rest(new Request(new URL(String(input), 'http://fixture'), init));
    const references = createRecipeScreenReferences(
      Object.fromEntries(definitions.map((def) => [def.name, def])),
      { fetch: fetcher },
    );
    const target = screenReferenceTarget(
      sourceDefinition,
      { name: 'preferredMat' },
      references,
    )!;
    expect(target.definition.objectRef).toBe(`${APP}:LoanerMats`);
    const page = await target.source.search!({
      query: 'Blue',
      offset: 0,
      limit: 10,
    });
    expect(screenRecordLabel(target.definition, page.rows[0])).toBe('Blue mat');
    expect(await target.source.get!(String(page.rows[0].id))).toMatchObject({
      matName: 'Blue mat',
    });

    const fields = (await lists()).find(
      (list) => list.label === 'Loaner mats',
    )?.fields;
    expect(fields).toContainEqual(
      expect.objectContaining({
        name: 'matName',
        label: 'Mat name',
        origin: 'yours',
      }),
    );
  });

  it('renames and hides/shows/removes fields, requires durable approval, preserves data and undoes', async () => {
    await write('app.addField', {
      list: 'Customers',
      label: 'Favourite colour',
      kind: 'text',
    });
    await rest(
      request('POST', 'customers', {
        name: 'Maya',
        favouriteColour: 'blue',
      }),
    );
    await write('app.renameField', {
      list: 'Customers',
      field: 'Favourite colour',
      label: 'Favourite shade',
    });
    await write('app.hideField', {
      list: 'Customers',
      field: 'Favourite shade',
    });
    expect(
      (await lists())[0].fields.find((f) => f.name === 'favouriteColour')
        ?.hidden,
    ).toBe(true);
    await write('app.showField', {
      list: 'Customers',
      field: 'Favourite shade',
    });
    expect(
      (await lists())[0].fields.find((f) => f.name === 'favouriteColour')
        ?.hidden,
    ).toBe(false);
    const before = editor.snapshot().revision;
    await write('app.removeField', {
      list: 'Customers',
      field: 'Favourite shade',
    });
    expect(editor.snapshot().revision).toBe(before);
    await approve('app.removeField', {
      list: 'Customers',
      field: 'Favourite shade',
    });
    expect(
      (await lists())[0].fields.find((f) => f.name === 'favouriteColour')
        ?.hidden,
    ).toBe(true);
    expect(
      (await db.query('SELECT favourite_colour FROM c6_customers')).rows[0]
        .favourite_colour,
    ).toBe('blue');
    const undo = await approve('app.undo', {});
    expect(undo.summary).toContain(
      'Removed Favourite shade from Customers and kept its data',
    );
    expect(
      (await lists())[0].fields.find((f) => f.name === 'favouriteColour')
        ?.hidden,
    ).toBe(false);
    expect((await call('app.history')).changes).toHaveLength(
      editor.snapshot().revision,
    );
  });

  it('renames pre-built and custom lists in the live cookbook and removes custom lists after approval', async () => {
    await write('app.renameList', {
      list: 'Customers',
      label: 'Members',
      iconMeaning: 'people',
    });
    expect(
      editor.snapshot().webDefinitions.find((d) => d.className === 'Customer'),
    ).toMatchObject({ label: 'Members', icon: 'users' });
    expect((await lists())[0]).toMatchObject({
      label: 'Members',
      icon: 'users',
    });
    expect(engine.snapshot().sections.flatMap((s) => s.items)).toContainEqual(
      expect.objectContaining({ label: 'Members', icon: 'users' }),
    );
    await write('app.addField', {
      list: 'Members',
      label: 'Joined',
      kind: 'date',
    });
    await write('app.addList', {
      label: 'Projects',
      fields: [{ label: 'Title', kind: 'text' }],
      nameField: 'Title',
    });
    await write('app.renameList', {
      list: 'Projects',
      label: 'Jobs',
      iconMeaning: 'repair',
    });
    expect((await lists()).find((l) => l.label === 'Jobs')).toMatchObject({
      origin: 'yours',
      icon: 'wrench',
    });
    await approve('app.removeList', { list: 'Jobs' });
    expect((await lists()).some((l) => l.label === 'Jobs')).toBe(false);
    await approve('app.undo', {});
    expect((await lists()).some((l) => l.label === 'Jobs')).toBe(true);
  });

  it('returns structured ambiguity, safe names and collisions without partial changes', async () => {
    await write('app.addList', {
      label: 'Prospects',
      fields: [{ label: 'Name', kind: 'text' }],
      nameField: 'Name',
    });
    await write('app.renameList', { list: 'Prospects', label: 'Customers' });
    const before = editor.snapshot().revision;
    const ambiguous = await write('app.addField', {
      list: 'the customers list',
      label: 'Note',
      kind: 'text',
    });
    expect(ambiguous).toMatchObject({
      status: 'clarification_required',
      candidates: [{ label: 'Customers' }, { label: 'Customers' }],
    });
    expect(editor.snapshot().revision).toBe(before);
    expect(
      await write('app.addField', {
        list: CUSTOMER,
        label: 'Name',
        kind: 'text',
      }),
    ).toMatchObject({ status: 'collision' });
    await write('app.addField', {
      list: CUSTOMER,
      label: '123 points',
      kind: 'number',
    });
    await write('app.addField', {
      list: CUSTOMER,
      label: 'Save',
      kind: 'text',
    });
    expect((await lists())[0].fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['field123Points', 'customSave']),
    );
    expect(
      await write('app.addList', {
        label: 'Duplicate',
        fields: [
          { label: 'First name', kind: 'text' },
          { label: 'First-name', kind: 'text' },
        ],
        nameField: 'First name',
      }),
    ).toMatchObject({ status: 'collision' });
  });

  it('offers app tools with pre-built parts off; rechecks owner, tenant and permissions on both transports', async () => {
    prebuilt = false;
    expect((await service.list(context)).map((d) => d.name)).toEqual([
      ...APP_TOOL_NAMES,
    ]);
    const generator = mcp();
    expect((await generator.generateTools()).map((d) => d.name)).toEqual([
      ...APP_TOOL_NAMES,
    ]);
    const tools = await service.assistantTools(context);
    const contract: PrincipalTool[] = tools;
    expect(contract.length).toBe(tools.length);
    const tool = tools.find((t) => t.slug === 'app.addField')!;
    const run = {
      context: { tenantId: TENANT, userId: USER },
      assertToolAllowed: vi.fn(),
      assertOperation: vi.fn(async () => {}),
    };
    expect(
      await tool.execute({
        run,
        args: {
          list: 'Customers',
          label: 'Note',
          kind: 'text',
          expectedRevision: 0,
        },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(run.assertOperation).toHaveBeenCalledWith('app', 'addField');
    owner = false;
    expect(await service.list(context)).toEqual([]);
    await expect(
      tool.execute({
        run,
        args: {
          list: 'Customers',
          label: 'Other',
          kind: 'text',
          expectedRevision: 1,
        },
      }),
    ).rejects.toThrow();
    expect(
      (
        await generator.handleToolCall({
          method: 'tools/call',
          params: { name: 'app.describe', arguments: {} },
        })
      ).isError,
    ).toBe(true);
    owner = true;
    permission = false;
    await expect(call('app.describe')).rejects.toThrow();
    permission = true;
    for (const identity of [
      { tenantId: OTHER },
      { userId: 'not-owner' },
      { userId: null },
      { tenantId: null },
    ])
      await expect(
        call('app.describe', {}, { ...context, ...identity }),
      ).rejects.toThrow();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'refused' }),
    );
  });

  it('uses the same MCP result and assistant schema, and recipe edits share durable history', async () => {
    const generator = mcp();
    const tools: PrincipalTool[] = await service.assistantTools(context);
    const offered = (await generator.generateTools()).find(
      (tool) => tool.name === 'app.addField',
    );
    expect(
      tools.find((tool) => tool.slug === 'app.addField')?.aiTool.function
        .parameters,
    ).toEqual(offered?.inputSchema);
    const response = await generator.handleToolCall({
      method: 'tools/call',
      params: {
        name: 'app.addField',
        arguments: {
          list: 'Customers',
          label: 'Note',
          kind: 'text',
          expectedRevision: 0,
        },
      },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      status: 'ok',
      summary: 'Added Note to Customers.',
    });
    await call('recipes.configure', {
      id: 'customers',
      expectedRevision: engine.snapshot().revision,
      items: [{ id: 'item:c6-upstream:Customer', label: 'Clients' }],
    });
    await write('app.addField', {
      list: 'Clients',
      label: 'Second note',
      kind: 'text',
    });
    expect(await editor.history()).toHaveLength(3);
  });

  it('supplies generated hosts the same live schemas, database, row labels and CRUD executor', async () => {
    await write('app.addList', {
      label: 'Projects',
      fields: [{ label: 'Project title', kind: 'text' }],
      nameField: 'Project title',
    });
    const live = await service.modelTools(context);
    expect(live).toBeDefined();
    const create = (await live!.generateTools()).find(
      (tool) => tool.name === 'projects_create',
    );
    expect(create?.inputSchema).toHaveProperty('properties.projectTitle');
    const result = await live!.handleToolCall({
      method: 'tools/call',
      params: {
        name: 'projects_create',
        arguments: { projectTitle: 'Garden' },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(
      (await db.query('SELECT project_title FROM projects')).rows,
    ).toMatchObject([{ project_title: 'Garden' }]);
    expect(
      (
        await live!.handleToolCall({
          method: 'tools/call',
          params: { name: 'projects_list', arguments: {} },
        })
      ).content[0].text,
    ).toContain('Garden');
  });

  it('keeps undone fields identified as yours and hides their archived storage', async () => {
    await write('app.addField', {
      list: 'Customers',
      label: 'Note',
      kind: 'text',
    });
    await approve('app.undo', {});
    expect(
      (await lists())[0].fields.find((field) => field.name === 'note'),
    ).toMatchObject({ hidden: true, origin: 'yours' });
  });

  it('shares every customization permission name with the browser-safe cookbook entry', async () => {
    expect(browserNames).toEqual(
      (await import('./tools.js')).COOKBOOK_TOOL_NAMES,
    );
    expect(browserNames.filter((name) => name.startsWith('app.'))).toEqual([
      ...APP_TOOL_NAMES,
    ]);
    expect((await service.list(context)).map((tool) => tool.name)).toEqual([
      ...browserNames,
    ]);
  });

  it('keeps exact provider inspection absent while tool edits and I/O resolve the effective app', async () => {
    await write('app.addField', {
      list: 'Customers',
      label: 'Preference',
      kind: 'text',
    });
    expect(ObjectRegistry.getClassByQualifiedName(CUSTOMER)).toBeUndefined();
    expect(
      ObjectRegistry.getClassInPackage('Customer', '@fixture/c6-upstream'),
    ).toBeUndefined();
    expect(ObjectRegistry.getClass(CUSTOMER)?.qualifiedName).toBe(
      `${APP}:Customer`,
    );
    expect(ObjectRegistry.resolveQualifiedName(CUSTOMER)).toBe(
      `${APP}:Customer`,
    );
    await write('app.renameField', {
      list: 'Customers',
      field: 'Preference',
      label: 'Favourite thing',
    });
    expect((await lists())[0].fields).toContainEqual(
      expect.objectContaining({
        name: 'preference',
        label: 'Favourite thing',
        origin: 'yours',
      }),
    );
    const live = await service.modelTools(context);
    expect(
      (await live!.generateTools()).find(
        (tool) => tool.name === 'customer_create',
      )?.inputSchema,
    ).toHaveProperty('properties.preference');
    const result = await rest(
      request('POST', 'customers', { name: 'Maya', preference: 'Blue' }),
    );
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ preference: 'Blue' });
  });

  it('composes custom-list readiness with activation and a disabled pre-built preference', async () => {
    const activation = createActivationCoordinator({
      scope: `c6-${randomUUID()}`,
      db,
      packageName: APP,
      manifest: {
        version: 1,
        modules: {
          customer: {
            specifier: 'fixture',
            models: [CUSTOMER],
            dependencies: [],
          },
        },
        models: {
          [CUSTOMER]: {
            module: 'customer',
            effective: CUSTOMER,
            table: 'c6_customers',
            dependencies: [],
          },
        },
        tables: { c6_customers: { owners: [CUSTOMER], dependencies: [] } },
      },
      loaders: { customer: async () => {} },
      readEnabled: async () => [CUSTOMER],
    });
    await activation.boot();
    setRuntimeExposureGate(activation.gate(gate));
    prebuilt = false;
    const generator = mcp();
    const changed = vi.fn();
    const stop = generator.onToolsListChanged(changed);
    expect((await service.list(context)).map((tool) => tool.name)).toEqual([
      ...APP_TOOL_NAMES,
    ]);
    expect((await rest(request('GET', 'customers'))).status).toBe(404);
    expect(activation.isReady(`${APP}:Projects`)).toBe(false);
    await write('app.addList', {
      label: 'Projects',
      fields: [{ label: 'Title', kind: 'text' }],
      nameField: 'Title',
    });
    expect(activation.isReady(`${APP}:Projects`)).toBe(true);
    expect(
      (await rest(request('POST', 'projects', { title: 'Garden' }))).status,
    ).toBe(201);
    const live = await service.modelTools(context);
    expect((await live!.generateTools()).map((tool) => tool.name)).toContain(
      'projects_create',
    );
    await approve('app.removeList', { list: 'Projects' });
    expect(activation.isReady(`${APP}:Projects`)).toBe(false);
    expect((await rest(request('GET', 'projects'))).status).toBe(404);
    await approve('app.undo', {});
    expect(activation.isReady(`${APP}:Projects`)).toBe(true);
    expect((await rest(request('GET', 'projects'))).status).toBe(200);
    expect(changed).toHaveBeenCalled();
    stop();
  });

  it('keeps the service approval authoritative alongside the chat bridge policy', async () => {
    await write('app.addField', {
      list: 'Customers',
      label: 'Note',
      kind: 'text',
    });
    const tool = (await service.assistantTools(context)).find(
      (tool) => tool.slug === 'app.removeField',
    )!;
    const args = { list: 'Customers', field: 'Note', expectedRevision: 1 };
    expect(requiresOwnerApproval(tool, args)).toBe(true);
    // This tool owns its action-specific durable hold; avoid wrapping it in a second chat hold.
    const bridge = createAssistantApprovalBridge({
      authority,
      tenantId: TENANT,
      requestedBy: USER,
      context: { driver: 'builtin' },
      policy: { tools: { [tool.slug]: false } },
    });
    expect(requiresOwnerApproval(tool, args, bridge.policy)).toBe(false);
    const run = {
      context: { tenantId: TENANT, userId: USER },
      assertToolAllowed: vi.fn(),
      assertOperation: vi.fn(async () => {}),
    };
    const held = await tool.execute({ run, args });
    expect(typeof held.approvalId).toBe('string');
    const heldId = String(held.approvalId);
    expect(held.status).toBe('approval_required');
    expect(editor.snapshot().revision).toBe(1);
    // A generic chat hold is bound to a different context and cannot approve this app edit.
    const generic = await bridge.request({ id: randomUUID(), tool, args });
    await authority.decide({ id: USER, tenantId: TENANT }, generic.id, true);
    await expect(
      tool.execute({ run, args: { ...args, approvalId: generic.id } }),
    ).rejects.toThrow('Approval');
    await authority.decide({ id: USER, tenantId: TENANT }, heldId, true);
    expect(
      await tool.execute({
        run,
        args: { ...args, approvalId: heldId },
      }),
    ).toMatchObject({ status: 'ok' });
    expect((await authority.get(TENANT, heldId))?.status).toBe('succeeded');
    await expect(
      tool.execute({ run, args: { ...args, approvalId: heldId } }),
    ).rejects.toThrow();
  });

  it('preserves STI base creates and explicit subtype dispatch after assistant field customization', async () => {
    const PROFILE = '@fixture/c6-profiles:Profile';
    const BOT = '@fixture/c6-profiles:Bot';
    class Profile extends SmrtObject {
      name = '';
    }
    field({ type: 'text' })(Profile.prototype, 'name');
    ObjectRegistry.register(Profile, {
      packageName: '@fixture/c6-profiles',
      tableName: 'c6_profiles',
      tableStrategy: 'sti',
      tenantScoped: true,
      api: true,
      mcp: true,
    });
    class Bot extends Profile {
      code = '';
    }
    field({ type: 'text' })(Bot.prototype, 'code');
    ObjectRegistry.register(Bot, {
      packageName: '@fixture/c6-profiles',
      tableName: 'c6_profiles',
      tableStrategy: 'sti',
      tenantScoped: true,
      api: true,
      mcp: true,
    });
    await migrateSmrtSchemas({
      db,
      engineHint: 'sqlite',
      packageName: '@fixture/c6-profiles',
      tables: new Set(['c6_profiles']),
    });
    const profileCatalog = {
      ...catalog,
      models: [
        ...catalog.models,
        {
          id: PROFILE,
          name: 'Profile',
          packageId: 'c6-profiles',
          exposed: true,
          fields: [{ name: 'name' }],
        },
        {
          id: BOT,
          name: 'Bot',
          packageId: 'c6-profiles',
          exposed: true,
          fields: [{ name: 'name' }, { name: 'code' }],
        },
      ],
      recipes: [
        ...catalog.recipes,
        {
          id: 'people',
          label: 'People',
          models: [PROFILE, BOT],
          nav: [{ model: PROFILE, label: 'People' }],
          requires: [],
        },
      ],
    };
    const cookbook = { ...initial(), recipes: ['customers', 'people'] };
    editor = await createAppModelEditor({
      db,
      application: 'c6-sti',
      tenantId: TENANT,
      packageName: APP,
      cookbook,
      catalog: profileCatalog,
      authorize: (c) => owner && c.actor === USER && c.tenantId === TENANT,
      publish: (snapshot) => {
        engine = createCookbookEngine({
          catalog: profileCatalog,
          state: {
            version: 1,
            revision: snapshot.revision,
            applied: null,
            cookbook: snapshot.cookbook,
            journal: [],
          },
        });
      },
    });
    service = createCookbookToolService({
      ...options,
      catalog: profileCatalog,
    });
    setCookbookToolService(service);
    gate.dispose();
    gate = createCookbookRuntimeExposure({
      catalog: profileCatalog,
      engineFor: (c) => (c.tenantId === TENANT ? engine : null),
    });
    setRuntimeExposureGate(gate);
    await write('app.addField', {
      list: 'People',
      label: 'Favourite colour',
      kind: 'text',
    });
    expect(ObjectRegistry.getClassByQualifiedName(PROFILE)).toBeUndefined();
    const generator = new MCPGenerator(
      { classNames: [PROFILE] },
      { db, tenantId: TENANT, user: { id: USER } },
    );
    const created = await generator.handleToolCall({
      method: 'tools/call',
      params: {
        name: 'profile_create',
        arguments: { name: 'Maya', favouriteColour: 'Blue' },
      },
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const bot = await generator.handleToolCall({
      method: 'tools/call',
      params: {
        name: 'profile_create',
        arguments: { name: 'Helper', _meta_type: BOT, code: 'bot' },
      },
    });
    expect(bot.isError, JSON.stringify(bot)).not.toBe(true);
    const rows = (
      await db.query(
        'SELECT name, _meta_type, favourite_colour FROM c6_profiles ORDER BY name',
      )
    ).rows;
    expect(rows).toMatchObject([
      { name: 'Helper', _meta_type: BOT },
      { name: 'Maya', _meta_type: `${APP}:Profile`, favourite_colour: 'Blue' },
    ]);
  });

  it('binds destructive approvals to the exact action, actor, tenant and revision', async () => {
    await write('app.addField', {
      list: 'Customers',
      label: 'Note',
      kind: 'text',
    });
    const args = { list: 'Customers', field: 'Note', expectedRevision: 1 };
    const hold = await call('app.removeField', args);
    await expect(
      call('app.removeField', { ...args, approvalId: hold.approvalId }),
    ).rejects.toThrow('Approval');
    await authority.decide(
      { id: USER, tenantId: TENANT },
      String(hold.approvalId),
      true,
    );
    await expect(
      call('app.removeField', {
        ...args,
        field: 'Name',
        approvalId: hold.approvalId,
      }),
    ).rejects.toThrow('Approval');
    owner = false;
    await expect(
      call('app.removeField', { ...args, approvalId: hold.approvalId }),
    ).rejects.toThrow();
    owner = true;
    await write('app.renameField', {
      list: 'Customers',
      field: 'Note',
      label: 'Notes',
    });
    await expect(
      call('app.removeField', {
        ...args,
        expectedRevision: 2,
        approvalId: hold.approvalId,
      }),
    ).rejects.toThrow();
    expect(
      (await lists())[0].fields.find((field) => field.name === 'note')?.hidden,
    ).toBe(false);
  });

  it('rechecks permissions after audit awaits and serializes competing revisions', async () => {
    options.audit = async (event) => {
      audit(event);
      if (event.outcome === 'requested') permission = false;
    };
    await expect(
      write('app.addField', { list: 'Customers', label: 'Nope', kind: 'text' }),
    ).rejects.toThrow();
    expect(await editor.history()).toHaveLength(0);
    permission = true;
    options.audit = async (event) => {
      audit(event);
    };
    const results = await Promise.allSettled([
      write('app.addField', {
        list: 'Customers',
        label: 'First',
        kind: 'text',
      }),
      write('app.addField', {
        list: 'Customers',
        label: 'Second',
        kind: 'text',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await editor.history()).toHaveLength(1);
  });

  it('keeps removed list rows, denies its REST route, and restores them on undo', async () => {
    await write('app.addList', {
      label: 'Projects',
      fields: [{ label: 'Title', kind: 'text' }],
      nameField: 'Title',
    });
    const created = await rest(
      request('POST', 'projects', { title: 'Garden' }),
    );
    expect(created.status).toBe(201);
    await approve('app.removeList', { list: 'Projects' });
    expect((await rest(request('GET', 'projects'))).status).toBe(404);
    expect((await db.query('SELECT title FROM projects')).rows).toMatchObject([
      { title: 'Garden' },
    ]);
    await approve('app.undo', {});
    expect((await rest(request('GET', 'projects'))).status).toBe(200);
  });

  it('compares the published engine projection after removing a labelled custom list', async () => {
    await write('app.addList', {
      label: 'Projects',
      fields: [{ label: 'Title', kind: 'text' }],
      nameField: 'Title',
    });
    await approve('app.removeList', { list: 'Projects' });
    // A normal host publishes cookbook documents through engine adoption.
    const projected = createCookbookEngine({
      catalog,
      cookbook: editor.snapshot().cookbook,
    });
    engine = createCookbookEngine({
      catalog,
      state: { ...engine.state(), cookbook: projected.cookbook() },
    });
    expect(editor.snapshot().cookbook.policies.length).toBeGreaterThan(
      engine.cookbook().policies.length,
    );
    expect(await approve('recipes.disable', { id: 'customers' })).toMatchObject(
      { status: 'ok' },
    );
    expect(engine.cookbook().recipes).not.toContain('customers');
  });

  it('asks about missing choices/currency and ambiguous field labels without journaling', async () => {
    expect(
      await write('app.addField', {
        list: 'Customers',
        label: 'Fee',
        kind: 'money',
      }),
    ).toMatchObject({ status: 'clarification_required' });
    expect(await editor.history()).toHaveLength(0);
    await write('app.addField', {
      list: 'Customers',
      label: 'Note',
      kind: 'text',
    });
    await write('app.renameField', {
      list: 'Customers',
      field: 'Name',
      label: 'Note',
    });
    expect(
      await write('app.hideField', { list: 'Customers', field: 'Note' }),
    ).toMatchObject({
      status: 'clarification_required',
      candidates: [{ name: 'name' }, { name: 'note' }],
    });
    expect(await editor.history()).toHaveLength(2);
    expect(
      editor.snapshot().webDefinitions.find((d) => d.className === 'Customer')
        ?.fieldPolicies.name.label,
    ).toBe('Note');
  });

  it('rejects malformed input, stale state and audit failures without effects', async () => {
    await expect(
      write('app.addField', {
        list: 'Customers',
        label: 'Bad',
        kind: 'unknown',
      }),
    ).rejects.toThrow();
    expect(
      await write('app.addField', {
        list: 'Customers',
        label: 'Choice',
        kind: 'choice',
      }),
    ).toMatchObject({ status: 'clarification_required' });
    await expect(
      write('app.addField', {
        list: 'Customers',
        label: 'Hack',
        kind: 'text',
        tenantId: OTHER,
      }),
    ).rejects.toThrow();
    await expect(
      call('app.addField', {
        list: 'Customers',
        label: 'Stale',
        kind: 'text',
        expectedRevision: 9,
      }),
    ).rejects.toThrow('changed');
    failAudit = true;
    await expect(
      write('app.addField', { list: 'Customers', label: 'Note', kind: 'text' }),
    ).rejects.toThrow('audit unavailable');
    expect(await editor.history()).toHaveLength(0);
  });
});

// @vitest-environment jsdom
/**
 * Browser form -> generated web definition -> generated REST integration.
 * Definitions are built from the Vitest plugin's real manifest through core's
 * shared web-definition builder; this test intentionally has no field maps.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { vi } from 'vitest';

vi.hoisted(() => {
  // The jsdom transform serves package shims through an http URL; this
  // integration owns explicit local registrations, so avoid an unrelated
  // package-manifest diagnostic while exercising the generated handler.
  process.env.SMRT_STRICT_REGISTRY = 'false';
});

// sql/esbuild behind the generated handler requires TextEncoder and Uint8Array
// from one realm. jsdom replaces the globals, so restore Node's encoder before
// the in-process server begins handling requests.
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
globalThis.Uint8Array = new TextEncoder().encode('')
  .constructor as Uint8ArrayConstructor;

import {
  APIGenerator,
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SmartObjectManifest } from '../../../../core/src/scanner/types.js';
import {
  buildWebCollectionDefinition,
  selectWebCollectionEntries,
} from '../../../../core/src/vite-plugin/web-collections.js';
import { FieldPolicyCollection } from '../../collections/FieldPolicyCollection.js';
import {
  MANAGE_FIELD_POLICY_PERMISSION,
  PERSONALIZE_FIELD_POLICY_PERMISSION,
} from '../../permissions.js';
import type { FieldPolicyEditorState } from '../../types.js';
import type { FieldPolicyEditorAdapter } from '../field-policy-editor.js';
import { ObjectFormSourceRegistry } from '../index.js';
import GeneratedApiGearFixture from './fixtures/GeneratedApiGearFixture.svelte';
import ObjectFormSourceFixture from './fixtures/ObjectFormSourceFixture.svelte';
import ObjectFormSourceSnippetFixture from './fixtures/ObjectFormSourceSnippetFixture.svelte';

@smrt({
  packageName: '@happyvertical/smrt-fields',
  visibility: 'internal',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: false,
  mcp: false,
})
class GeneratedApiProduct extends SmrtObject {
  @field({ required: true })
  name: string = '';

  @field({ type: 'decimal' })
  price: number = 0;

  @field({ type: 'boolean', default: false })
  published: boolean = false;
}

@smrt({
  packageName: '@happyvertical/smrt-fields',
  visibility: 'internal',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: false,
  mcp: false,
})
class GeneratedApiEvent extends SmrtObject {
  @field({ required: true })
  title: string = '';

  @field({ type: 'datetime' })
  startsAt: string = '';

  @field({ type: 'json' })
  metadata: Record<string, unknown> = {};
}

class GeneratedApiProductCollection extends SmrtCollection<GeneratedApiProduct> {
  static readonly _itemClass = GeneratedApiProduct;
}

class GeneratedApiEventCollection extends SmrtCollection<GeneratedApiEvent> {
  static readonly _itemClass = GeneratedApiEvent;
}

const passThroughAuth =
  () =>
  async (request: Request): Promise<Request> =>
    request;

function ref(ctor: typeof SmrtObject): string {
  const registered = ObjectRegistry.getClassByConstructor(ctor);
  if (!registered?.qualifiedName)
    throw new Error('generated API fixture was not registered');
  return registered.qualifiedName;
}

function generatedDefinitions(): Record<
  string,
  ReturnType<typeof buildWebCollectionDefinition>
> {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), 'dist/manifest.json'), 'utf8'),
  ) as SmartObjectManifest;
  return Object.fromEntries(
    selectWebCollectionEntries(manifest).map((entry) => [
      entry.obj.qualifiedName,
      buildWebCollectionDefinition(entry, manifest),
    ]),
  );
}

describe('ObjectForm generated API integration', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let policies: FieldPolicyCollection;
  let handler: (request: Request) => Promise<Response>;
  let definitions: Record<
    string,
    ReturnType<typeof buildWebCollectionDefinition>
  >;
  const tenantId = '8cd50df6-7cfb-4fcf-b06f-9d8acb55f22e';
  const aliceId = '61514216-1d0b-4a6e-b501-20f5d8baf86e';
  const bobId = '24657fd2-2813-4c43-b5af-0c916cbce3bc';

  beforeEach(async () => {
    setupTestTenancy();
    db = await getTestDatabase({
      classes: [
        'FieldPolicy',
        'Tenant',
        'GeneratedApiProduct',
        'GeneratedApiEvent',
      ],
    });
    policies = await FieldPolicyCollection.create({ db });
    const products = await GeneratedApiProductCollection.create({ db });
    const events = await GeneratedApiEventCollection.create({ db });
    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('fieldpolicy', policies);
    api.registerCollection('generatedapiproduct', products);
    api.registerCollection('generatedapievent', events);
    handler = api.generateHandler();
    definitions = generatedDefinitions();
  });

  afterEach(async () => {
    resetTenancy();
    await db?.close?.();
  });

  async function requestAs(
    userId: string,
    permissions: Set<string>,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    return withTenant({ tenantId, userId, permissions }, () =>
      handler(new Request(`http://localhost/api/v1${path}`, init)),
    );
  }

  function request(path: string, init?: RequestInit): Promise<Response> {
    return requestAs(aliceId, new Set(), path, init);
  }

  function sourceFor(
    objectRef: string,
    userId = aliceId,
    permissions = new Set<string>(),
  ): ObjectFormSourceRegistry {
    const definition = definitions[objectRef];
    if (!definition)
      throw new Error(`missing generated definition for ${objectRef}`);
    const resolveBatch = vi.fn(async (input: { objectRefs: string[] }) => {
      const response = await requestAs(
        userId,
        permissions,
        '/fieldpolicy/resolve',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      if (response.status !== 200) {
        throw new Error(
          `resolveBatch HTTP ${response.status}: ${await response.text()}`,
        );
      }
      const envelope = (await response.json()) as {
        action: string;
        result: unknown;
      };
      expect(envelope.action).toBe('resolveBatch');
      return envelope.result;
    });
    const source = new ObjectFormSourceRegistry({ resolveBatch });
    source.register(definition);
    return source;
  }

  function gearAdapter(
    userId: string,
    permissions: Set<string>,
  ): FieldPolicyEditorAdapter {
    async function action(
      path: string,
      init: RequestInit,
    ): Promise<{ status: number; body: unknown }> {
      const response = await requestAs(userId, permissions, path, init);
      const body = await response.json().catch(() => undefined);
      return { status: response.status, body };
    }
    return {
      async load(input) {
        const result = await action('/fieldpolicy/editor-state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (result.status === 403)
          return (result.body as { error: unknown }).error as never;
        if (result.status !== 200)
          throw new Error(`editor-state HTTP ${result.status}`);
        const envelope = result.body as { action: string; result: unknown };
        expect(envelope.action).toBe('getEditorState');
        return envelope.result as never;
      },
      async create(input) {
        const result = await action('/fieldpolicy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (result.status !== 201)
          throw new Error(`create HTTP ${result.status}`);
        return result.body;
      },
      async update(input) {
        const { id, ...body } = input;
        const result = await action(`/fieldpolicy/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (result.status !== 200)
          throw new Error(`update HTTP ${result.status}`);
        return result.body;
      },
      async delete(input) {
        const response = await requestAs(
          userId,
          permissions,
          `/fieldpolicy/${input.id}`,
          { method: 'DELETE' },
        );
        if (response.status !== 204)
          throw new Error(`delete HTTP ${response.status}`);
      },
    };
  }

  it('renders two generated definitions with no per-object fields and persists create/update via generated routes', async () => {
    const productRef = ref(GeneratedApiProduct);
    const eventRef = ref(GeneratedApiEvent);
    const productDefinition = definitions[productRef];
    const eventDefinition = definitions[eventRef];
    await expect(
      withTenant({ tenantId, userId: aliceId, permissions: new Set() }, () =>
        policies.resolveBatch({ objectRefs: [productRef] }),
      ),
    ).resolves.toMatchObject({
      policies: { [productRef]: { objectRef: productRef } },
    });
    expect(productDefinition.fields).toMatchObject({
      name: { type: 'text' },
      price: { type: 'decimal' },
      published: { type: 'boolean' },
    });
    expect(eventDefinition.fields).toMatchObject({
      title: { type: 'text' },
      startsAt: { type: 'datetime' },
      metadata: { type: 'json' },
    });

    const productView = render(ObjectFormSourceSnippetFixture, {
      props: { source: sourceFor(productRef), objectRef: productRef },
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Custom generated name' }),
      ).toBeInTheDocument(),
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Custom generated name' }),
      'launch',
    );
    await userEvent.type(screen.getByRole('spinbutton'), '19.5');
    const productRecord = JSON.parse(
      screen.getByTestId('record').textContent ?? '{}',
    );
    expect(productRecord).toMatchObject({ name: 'LAUNCH', price: 19.5 });
    const created = await request(productDefinition.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(productRecord),
    });
    expect(created.status).toBe(201);
    const product = (await created.json()) as {
      id: string;
      name: string;
      price: number;
    };
    expect(product).toMatchObject({ name: 'LAUNCH', price: 19.5 });
    const updated = await request(
      `${productDefinition.endpoint}/${product.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ price: 22 }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: product.id, price: 22 });
    productView.unmount();

    render(ObjectFormSourceFixture, {
      props: {
        source: sourceFor(eventRef),
        objectRef: eventRef,
        isNewRecord: false,
        initialValue: {
          title: 'Existing event',
          startsAt: '2026-08-08T10:00',
          metadata: { venue: 'Hall A' },
        },
      },
    });
    await vi.waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
        'Existing event',
      ),
    );
    expect(
      (screen.getByRole('textbox', { name: 'Metadata' }) as HTMLTextAreaElement)
        .value,
    ).toContain('Hall A');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Title' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Title' }),
      'Updated event',
    );
    expect(screen.getByTestId('record')).toHaveTextContent('Updated event');
    const eventRecord = JSON.parse(
      screen.getByTestId('record').textContent ?? '{}',
    ) as Record<string, unknown>;
    const createdEvent = await request(eventDefinition.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(eventRecord),
    });
    expect(createdEvent.status).toBe(201);
    const event = (await createdEvent.json()) as {
      id: string;
      title: string;
      metadata: { venue: string };
    };
    expect(event).toMatchObject({
      title: 'Updated event',
      metadata: { venue: 'Hall A' },
    });
    const updatedEvent = await request(
      `${eventDefinition.endpoint}/${event.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Republished event' }),
      },
    );
    expect(updatedEvent.status).toBe(200);
    expect(await updatedEvent.json()).toMatchObject({
      id: event.id,
      title: 'Republished event',
    });
  });

  it('drives gear organization, personal, lock, reset, and denial through APIGenerator', async () => {
    const eventRef = ref(GeneratedApiEvent);
    const fields = definitions[eventRef].fields;
    const alicePermissions = new Set([
      MANAGE_FIELD_POLICY_PERMISSION,
      PERSONALIZE_FIELD_POLICY_PERMISSION,
    ]);
    const bobPermissions = new Set([PERSONALIZE_FIELD_POLICY_PERMISSION]);
    const alice = render(GeneratedApiGearFixture, {
      props: {
        objectRef: eventRef,
        fields,
        adapter: gearAdapter(aliceId, alicePermissions),
      },
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Field settings' }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Field settings' }),
    );
    await vi.waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: 'Field settings' }),
      ).toBeInTheDocument(),
    );
    const organizationTitle = screen.getByRole('group', { name: 'title' });
    await userEvent.type(
      within(organizationTitle).getByRole('textbox', { name: 'Label' }),
      'Organization title',
    );
    await userEvent.click(
      within(organizationTitle).getByRole('button', { name: 'Save' }),
    );
    await vi.waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: 'Field settings' }),
      ).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Just me' }));
    const personalTitle = screen.getByRole('group', {
      name: 'Organization title',
    });
    await userEvent.clear(
      within(personalTitle).getByRole('textbox', { name: 'Label' }),
    );
    await userEvent.type(
      within(personalTitle).getByRole('textbox', { name: 'Label' }),
      'Alice title',
    );
    await userEvent.click(
      within(personalTitle).getByRole('button', { name: 'Save' }),
    );
    await vi.waitFor(async () => {
      const state = (await gearAdapter(aliceId, alicePermissions).load({
        objectRef: eventRef,
      })) as FieldPolicyEditorState;
      expect(state.policy.fields.title.label).toBe('Alice title');
    });
    alice.unmount();

    await expect(
      gearAdapter(bobId, bobPermissions).load({ objectRef: eventRef }),
    ).resolves.toMatchObject({
      policy: { fields: { title: { label: 'Organization title' } } },
    });

    const bobForm = render(ObjectFormSourceFixture, {
      props: {
        source: sourceFor(eventRef, bobId, bobPermissions),
        objectRef: eventRef,
      },
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Organization title' }),
      ).toBeInTheDocument(),
    );
    bobForm.unmount();

    const aliceReset = render(GeneratedApiGearFixture, {
      props: {
        objectRef: eventRef,
        fields,
        adapter: gearAdapter(aliceId, alicePermissions),
      },
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Field settings' }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Field settings' }),
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Just me' }));
    const resetTitle = await screen.findByRole('group', {
      name: 'Alice title',
    });
    await userEvent.click(
      within(resetTitle).getByRole('button', { name: 'Reset to inherited' }),
    );
    await vi.waitFor(async () => {
      const state = (await gearAdapter(aliceId, alicePermissions).load({
        objectRef: eventRef,
      })) as FieldPolicyEditorState;
      expect(state.policy.fields.title.label).toBe('Organization title');
    });
    aliceReset.unmount();

    const aliceLock = render(GeneratedApiGearFixture, {
      props: {
        objectRef: eventRef,
        fields,
        adapter: gearAdapter(aliceId, alicePermissions),
      },
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Field settings' }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Field settings' }),
    );
    const lockTitle = await screen.findByRole('group', {
      name: 'Organization title',
    });
    await userEvent.click(
      within(lockTitle).getByRole('checkbox', {
        name: 'Lock Organization title',
      }),
    );
    await userEvent.click(
      within(lockTitle).getByRole('button', { name: 'Save' }),
    );
    aliceLock.unmount();

    const bob = render(GeneratedApiGearFixture, {
      props: {
        objectRef: eventRef,
        fields,
        adapter: gearAdapter(bobId, bobPermissions),
      },
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Field settings' }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Field settings' }),
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Just me' }));
    const lockedTitle = await screen.findByRole('group', {
      name: 'Organization title',
    });
    expect(
      within(lockedTitle).getByText(/locked by your organization/i),
    ).toBeInTheDocument();
    expect(
      within(lockedTitle).getByRole('button', { name: 'Save' }),
    ).toBeDisabled();
    const lockedWrite = await requestAs(bobId, bobPermissions, '/fieldpolicy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objectRef: eventRef,
        fieldName: 'title',
        scopeType: 'user',
        defaultValue: null,
        displayOrder: null,
        help: null,
        label: 'Rejected',
        locked: null,
        visibility: null,
      }),
    });
    expect(lockedWrite.status).toBe(403);
    expect(await lockedWrite.json()).toMatchObject({
      error: {
        code: 'permission_denied',
        message: expect.stringMatching(/locked by org policy/i),
        ok: false,
        status: 403,
      },
    });
    bob.unmount();

    const denied = render(GeneratedApiGearFixture, {
      props: {
        objectRef: eventRef,
        fields,
        adapter: gearAdapter('4adca9ba-13e9-473a-bb6c-b0a4c9972c1d', new Set()),
      },
    });
    await vi.waitFor(() =>
      expect(
        screen.queryByText('Loading field settings…'),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Field settings' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    denied.unmount();
  });
});

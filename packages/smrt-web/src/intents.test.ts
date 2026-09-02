/**
 * Declarative view intents (#2588) — contract, registry, compilation, the
 * exposure policy, and the hard no-REST invariant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearViewIntentRegistry,
  compileViewIntentToolSpec,
  defineIntent,
  listViewIntents,
  resolveViewIntent,
  type ViewIntentControlRegistryPort,
  type ViewIntentDataSurfaceRegistryPort,
  type ViewIntentDeclaration,
  viewIntentToolName,
} from './intents.js';
import { registerViewIntent } from './webmcp.js';

interface RecordedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

let tools: RecordedTool[] = [];

function installModelContext(): void {
  (globalThis as { document?: unknown }).document = {
    modelContext: {
      registerTool(tool: RecordedTool) {
        tools.push(tool);
        return Promise.resolve();
      },
    },
  };
}

function controlRegistry(
  result: { ok: boolean; reason?: string } = { ok: true },
): ViewIntentControlRegistryPort & {
  calls: Array<{ command: unknown; context: unknown }>;
} {
  const calls: Array<{ command: unknown; context: unknown }> = [];
  return {
    calls,
    execute: async (command, context) => {
      calls.push({ command, context });
      return result;
    },
  };
}

function dataSurfaceRegistry(
  revision: number | null = 4,
  result: { ok: boolean; revision?: number; reason?: string } = {
    ok: true,
    revision: 5,
  },
): ViewIntentDataSurfaceRegistryPort & { commands: unknown[] } {
  const commands: unknown[] = [];
  return {
    commands,
    inspect: () => (revision === null ? undefined : { revision }),
    execute: async (command) => {
      commands.push(command);
      return result;
    },
  };
}

beforeEach(() => {
  clearViewIntentRegistry();
  tools = [];
});

afterEach(() => {
  clearViewIntentRegistry();
  (globalThis as { document?: unknown }).document = undefined;
  vi.restoreAllMocks();
});

describe('defineIntent', () => {
  it('resolves an omitted capability through the shared fail-closed rule', () => {
    const intent = defineIntent({
      id: 'orders.open_archived_tab',
      description: 'Open the archived orders tab',
      target: { registry: 'control', action: 'focus' },
    });

    expect(intent.classification).toEqual({
      effect: 'destructive',
      destructive: true,
      idempotent: false,
      openWorld: true,
    });
    expect(intent.kind).toBe('intent');
    expect(intent.planes).toEqual(['browser']);
  });

  it('defaults each capability field independently', () => {
    const intent = defineIntent({
      id: 'orders.explain_status',
      description: 'Explain the status control',
      capability: { effect: 'read' },
      target: { registry: 'control', action: 'explain' },
    });

    // A declared `read` effect does NOT imply idempotent (#2587).
    expect(intent.classification).toEqual({
      effect: 'read',
      destructive: false,
      idempotent: false,
      openWorld: true,
    });
  });

  it('freezes the intent and registers it under its id', () => {
    const intent = defineIntent({
      id: 'orders.reveal_total',
      description: 'Reveal the order total',
      capability: { effect: 'read', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'reveal' },
    });

    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.target)).toBe(true);
    expect(resolveViewIntent('orders.reveal_total')).toBe(intent);
    expect(listViewIntents()).toEqual([intent]);
  });

  it('is idempotent for an identical re-declaration and replaces a changed one', () => {
    const declaration: ViewIntentDeclaration = {
      id: 'orders.filter_list',
      description: 'Filter the order list',
      capability: { effect: 'write', idempotent: true, openWorld: false },
      target: { registry: 'dataSurface', controlId: 'filter' },
    };

    const first = defineIntent({ ...declaration });
    const second = defineIntent({ ...declaration });
    expect(second).toBe(first);

    // A DIFFERING re-declaration replaces and warns rather than throwing:
    // editing a sidecar is exactly what an HMR update does, and throwing
    // there would break the dev loop.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replaced = defineIntent({
      ...declaration,
      description: 'Something else',
    });
    expect(replaced.description).toBe('Something else');
    expect(resolveViewIntent('orders.filter_list')).toBe(replaced);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('requires a namespaced, lowercase id', () => {
    for (const id of ['orders', 'Orders.filter', 'orders.', '.filter']) {
      expect(() =>
        defineIntent({
          id,
          description: 'x',
          target: { registry: 'control', action: 'focus' },
        }),
      ).toThrow(/namespaced|non-empty/);
    }
  });

  it('refuses two ids that flatten to the same WebMCP tool name', () => {
    defineIntent({
      id: 'orders.foo_bar',
      description: 'x',
      target: { registry: 'control', action: 'focus' },
    });

    // Distinct in the id-keyed registry, identical after flattening — they
    // would otherwise fight over one WebMCP tool name at mount.
    expect(() =>
      defineIntent({
        id: 'orders.foo.bar',
        description: 'x',
        target: { registry: 'control', action: 'focus' },
      }),
    ).toThrow(/derives the WebMCP tool name 'orders_foo_bar'/);
  });

  it('refuses the reserved smrt_ui_ namespace of the six fixed tools', () => {
    expect(() =>
      defineIntent({
        id: 'smrt.ui_list_controls',
        description: 'Shadow a fixed tool',
        target: { registry: 'control', action: 'focus' },
      }),
    ).toThrow(/reserved 'smrt_ui_' namespace/);
  });

  it('rejects an unknown target action, registry, and surface kind', () => {
    expect(() =>
      defineIntent({
        id: 'orders.bad_action',
        description: 'x',
        target: {
          registry: 'control',
          action: 'submit',
        } as unknown as ViewIntentDeclaration['target'],
      }),
    ).toThrow(/target.action must be one of/);

    expect(() =>
      defineIntent({
        id: 'orders.bad_registry',
        description: 'x',
        target: {
          registry: 'rest',
        } as unknown as ViewIntentDeclaration['target'],
      }),
    ).toThrow(/target.registry must be/);

    expect(() =>
      defineIntent({
        id: 'orders.bad_kind',
        description: 'x',
        target: {
          registry: 'dataSurface',
          controlId: 'filter',
          kind: 'graphql',
        } as unknown as ViewIntentDeclaration['target'],
      }),
    ).toThrow(/target.kind must be one of/);
  });
});

describe('the no-REST invariant', () => {
  it('rejects a declaration that smuggles an execute function', () => {
    expect(() =>
      defineIntent({
        id: 'orders.smuggled_execute',
        description: 'x',
        target: { registry: 'control', action: 'focus' },
        // The declaration type has no `execute` field at all; this is the
        // `as any` escape a determined author would reach for.
        execute: async () => {
          await fetch('/api/v1/orders', { method: 'DELETE' });
          return 'done';
        },
      } as unknown as ViewIntentDeclaration),
    ).toThrow(/unknown key 'execute'/);
  });

  it('rejects every other network-shaped key', () => {
    for (const key of ['fetch', 'url', 'route', 'endpoint', 'method']) {
      expect(() =>
        defineIntent({
          id: `orders.smuggled_${key}`,
          description: 'x',
          target: { registry: 'control', action: 'focus' },
          [key]: '/api/v1/orders',
        } as unknown as ViewIntentDeclaration),
      ).toThrow(new RegExp(`unknown key '${key}'`));
    }
  });

  it('rejects a function nested anywhere inside an allowed field', () => {
    expect(() =>
      defineIntent({
        id: 'orders.smuggled_nested',
        description: 'x',
        inputSchema: {
          type: 'object',
          properties: { evil: { default: () => fetch('/api/v1/orders') } },
        },
        target: { registry: 'control', action: 'focus' },
      } as unknown as ViewIntentDeclaration),
    ).toThrow(/is a function/);
  });

  it('keeps a JSON copy, so a getter cannot swap in a function after the check', () => {
    let reads = 0;
    const declaration = {
      id: 'orders.toctou_schema',
      description: 'x',
      target: { registry: 'control', action: 'focus' },
    } as unknown as ViewIntentDeclaration;
    Object.defineProperty(declaration, 'inputSchema', {
      enumerable: true,
      get() {
        reads += 1;
        // Clean JSON on the first read the validator makes; a callable on
        // every read after it. A validate-then-store-by-reference
        // implementation would freeze the second value into the intent.
        return reads === 1
          ? { type: 'object', properties: {} }
          : { type: 'object', evil: () => fetch('/api/v1/orders') };
      },
    });

    const intent = defineIntent(declaration);

    expect(reads).toBe(1);
    expect(intent.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(intent.inputSchema).not.toHaveProperty('evil');
  });

  it('copies agent-supplied arguments before dispatching them', async () => {
    const intent = defineIntent({
      id: 'orders.toctou_value',
      description: 'x',
      capability: { effect: 'write' },
      target: { registry: 'control', action: 'stage' },
    });
    const registry = controlRegistry();
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'control',
      registryPort: registry,
      identity: { formId: 'order-form', controlId: 'notes' },
    });

    let reads = 0;
    const args: Record<string, unknown> = {};
    Object.defineProperty(args, 'value', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? { note: 'clean' } : { note: () => fetch('/x') };
      },
    });

    await spec.execute(args);

    const command = registry.calls[0]?.command as Record<string, unknown>;
    expect(command.value).toEqual({ note: 'clean' });
  });

  it('keeps an own __proto__ key as data instead of swapping the prototype', () => {
    const intent = defineIntent({
      id: 'orders.proto_schema',
      description: 'x',
      // `JSON.parse('{"__proto__":{}}')` produces exactly this own key, so an
      // agent-supplied or file-loaded schema can carry one.
      inputSchema: JSON.parse('{"type":"object","__proto__":{"polluted":1}}'),
      target: { registry: 'control', action: 'focus' },
    });

    expect(Object.getPrototypeOf(intent.inputSchema)).toBe(Object.prototype);
    expect(
      (Object.prototype as unknown as Record<string, unknown>).polluted,
    ).toBeUndefined();
    expect(Object.hasOwn(intent.inputSchema, '__proto__')).toBe(true);
  });

  it('never calls fetch when a compiled intent executes', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    const intent = defineIntent({
      id: 'orders.stage_status',
      description: 'Propose a new status',
      capability: { effect: 'write', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'stage', controlId: 'status' },
    });
    const registry = controlRegistry();
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'control',
      registryPort: registry,
      identity: { formId: 'order-form', controlId: 'status' },
    });

    const result = await spec.execute({ value: 'archived' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toEqual({
      ok: true,
      action: 'stage',
      identity: { formId: 'order-form', controlId: 'status' },
    });
    // The ONLY thing execution did was dispatch one registry command.
    expect(registry.calls).toEqual([
      {
        command: {
          action: 'stage',
          identity: { formId: 'order-form', controlId: 'status' },
          value: 'archived',
        },
        context: { source: 'agent' },
      },
    ]);

    vi.unstubAllGlobals();
  });
});

describe('compileViewIntentToolSpec', () => {
  it('dispatches as source agent so staged review stays on the path', async () => {
    const intent = defineIntent({
      id: 'orders.apply_status',
      description: 'Apply the staged status',
      capability: { effect: 'write' },
      target: { registry: 'control', action: 'apply' },
    });
    const registry = controlRegistry({
      ok: false,
      reason: 'human_confirmation_required',
    });
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'control',
      registryPort: registry,
      identity: { formId: 'order-form', controlId: 'status' },
    });

    const result = await spec.execute({ value: 'archived', revision: 2 });

    expect(JSON.parse(result)).toEqual({
      ok: false,
      reason: 'human_confirmation_required',
    });
    const command = registry.calls[0]?.command as Record<string, unknown>;
    // Never set from arguments: an agent must not be able to claim a human
    // staged review.
    expect(command).not.toHaveProperty('reviewedValueIsCanonical');
    expect(command.revision).toBe(2);
  });

  it('collapses an unrecognized registry reason to denied', async () => {
    const intent = defineIntent({
      id: 'orders.focus_status',
      description: 'Focus the status control',
      capability: { effect: 'read', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'focus' },
    });
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'control',
      registryPort: controlRegistry({
        ok: false,
        reason: 'internal: row 42 of orders_secret',
      }),
      identity: { formId: 'order-form', controlId: 'status' },
    });

    expect(JSON.parse(await spec.execute({}))).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('builds a data-surface visible command at the surface revision', async () => {
    const intent = defineIntent({
      id: 'orders.next_page',
      description: 'Advance the orders table',
      capability: { effect: 'read', idempotent: false, openWorld: false },
      target: {
        registry: 'dataSurface',
        controlId: 'next-page',
        kind: 'table',
      },
    });
    const registry = dataSurfaceRegistry();
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'dataSurface',
      registryPort: registry,
      identity: { surfaceId: 'orders-table', kind: 'table' },
    });

    const result = await spec.execute({ payload: { cursor: 'abc' } });

    expect(JSON.parse(result)).toMatchObject({ ok: true, revision: 5 });
    expect(registry.commands[0]).toMatchObject({
      version: 1,
      identity: { surfaceId: 'orders-table', kind: 'table' },
      expectedRevision: 4,
      controlId: 'next-page',
      payload: { cursor: 'abc' },
    });
  });

  it('reports not_found when the surface is not mounted', async () => {
    const intent = defineIntent({
      id: 'orders.unmounted_page',
      description: 'Advance an unmounted table',
      target: { registry: 'dataSurface', controlId: 'next-page' },
    });
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'dataSurface',
      registryPort: dataSurfaceRegistry(null),
      identity: { surfaceId: 'orders-table', kind: 'table' },
    });

    expect(JSON.parse(await spec.execute({}))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('fails closed on a non-object argument instead of throwing', async () => {
    const intent = defineIntent({
      id: 'orders.nonobject_args',
      description: 'x',
      capability: { effect: 'write' },
      target: { registry: 'control', action: 'stage' },
    });
    const registry = controlRegistry();
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'control',
      registryPort: registry,
      identity: { formId: 'order-form', controlId: 'notes' },
    });

    // WebMCP hands `execute` whatever the agent sent; `'value' in args` would
    // throw a TypeError on a primitive.
    for (const args of ['nope', 42, [1, 2], null] as unknown[]) {
      expect(
        JSON.parse(await spec.execute(args as Record<string, unknown>)),
      ).toEqual({ ok: false, reason: 'invalid_request' });
    }
    expect(registry.calls).toHaveLength(0);
  });

  it('forwards a subject-qualified control identity unchanged', async () => {
    const intent = defineIntent({
      id: 'orders.subject_focus',
      description: 'x',
      capability: { effect: 'read', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'focus' },
    });
    const registry = controlRegistry();
    const identity = {
      formId: 'order-form',
      controlId: 'notes',
      subject: { type: 'order', id: 'order-7', label: 'Order 7' },
    };
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'control',
      registryPort: registry,
      identity,
    });

    await spec.execute({});

    const command = registry.calls[0]?.command as Record<string, unknown>;
    expect(command.identity).toEqual(identity);
  });

  it('forwards a subject-qualified data-surface identity unchanged', async () => {
    const intent = defineIntent({
      id: 'orders.subject_page',
      description: 'x',
      capability: { effect: 'read', idempotent: false, openWorld: false },
      target: { registry: 'dataSurface', controlId: 'next-page' },
    });
    const registry = dataSurfaceRegistry();
    const identity = {
      surfaceId: 'orders-table',
      kind: 'table' as const,
      subject: { type: 'account', id: 'acct-3' },
    };
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'dataSurface',
      registryPort: registry,
      identity,
    });

    await spec.execute({});

    expect(registry.commands[0]).toMatchObject({ identity });
  });

  it('collapses a throwing data-surface registry to an allowlisted reason', async () => {
    const intent = defineIntent({
      id: 'orders.throwing_surface',
      description: 'x',
      capability: { effect: 'read', idempotent: false, openWorld: false },
      target: { registry: 'dataSurface', controlId: 'next-page' },
    });
    // The REAL DataSurfaceRegistry throws — not returns — for a payload that
    // is too deep, too large, or carries a forbidden or prototype-pollution
    // key (`normalizeDataSurfaceVisibleCommand` in smrt-ui). An uncaught
    // throw would escape both the `{ ok, reason }` contract and the
    // `publicReason` allowlist.
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'dataSurface',
      registryPort: {
        inspect: () => ({ revision: 1 }),
        execute: async () => {
          throw new TypeError('forbidden key at $.payload.tenantId');
        },
      },
      identity: { surfaceId: 'orders-table', kind: 'table' },
    });

    expect(JSON.parse(await spec.execute({ payload: { a: 1 } }))).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('collapses a throwing inspect and a throwing control registry too', async () => {
    const surfaceIntent = defineIntent({
      id: 'orders.throwing_inspect',
      description: 'x',
      capability: { effect: 'read', idempotent: false, openWorld: false },
      target: { registry: 'dataSurface', controlId: 'next-page' },
    });
    const surfaceSpec = compileViewIntentToolSpec(surfaceIntent, {
      registry: 'dataSurface',
      registryPort: {
        inspect: () => {
          throw new Error('internal: surfaces table row 42');
        },
        execute: async () => ({ ok: true }),
      },
      identity: { surfaceId: 'orders-table', kind: 'table' },
    });
    expect(JSON.parse(await surfaceSpec.execute({}))).toEqual({
      ok: false,
      reason: 'denied',
    });

    const controlIntent = defineIntent({
      id: 'orders.throwing_control',
      description: 'x',
      capability: { effect: 'read', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'focus' },
    });
    const controlSpec = compileViewIntentToolSpec(controlIntent, {
      registry: 'control',
      registryPort: {
        execute: async () => {
          throw new Error('internal: control host blew up');
        },
      },
      identity: { formId: 'order-form', controlId: 'notes' },
    });
    expect(JSON.parse(await controlSpec.execute({}))).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('rejects a binding to the wrong registry', () => {
    const intent = defineIntent({
      id: 'orders.mismatched',
      description: 'x',
      target: { registry: 'control', action: 'focus' },
    });

    expect(() =>
      compileViewIntentToolSpec(intent, {
        registry: 'dataSurface',
        registryPort: dataSurfaceRegistry(),
        identity: { surfaceId: 'orders-table', kind: 'table' },
      }),
    ).toThrow(/targets the control registry but was bound to dataSurface/);
  });

  it('rejects a binding that contradicts a declared identity', () => {
    const intent = defineIntent({
      id: 'orders.declared_control',
      description: 'x',
      target: { registry: 'control', action: 'focus', controlId: 'status' },
    });

    expect(() =>
      compileViewIntentToolSpec(intent, {
        registry: 'control',
        registryPort: controlRegistry(),
        identity: { formId: 'order-form', controlId: 'notes' },
      }),
    ).toThrow(/declares controlId 'status' but was bound to 'notes'/);
  });

  it('refuses a non-JSON argument rather than passing it to the registry', async () => {
    const intent = defineIntent({
      id: 'orders.stage_notes',
      description: 'x',
      capability: { effect: 'write' },
      target: { registry: 'control', action: 'stage' },
    });
    const registry = controlRegistry();
    const spec = compileViewIntentToolSpec(intent, {
      registry: 'control',
      registryPort: registry,
      identity: { formId: 'order-form', controlId: 'notes' },
    });

    expect(JSON.parse(await spec.execute({ value: () => 'nope' }))).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(registry.calls).toHaveLength(0);
  });
});

describe('registerViewIntent', () => {
  beforeEach(installModelContext);

  it('registers through the bespoke registrar with round-tripped hints', async () => {
    const intent = defineIntent({
      id: 'orders.reveal_notes',
      description: 'Reveal the notes control',
      capability: { effect: 'read', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'reveal' },
    });

    const disposer = registerViewIntent(
      intent,
      {
        registry: 'control',
        registryPort: controlRegistry(),
        identity: { formId: 'order-form', controlId: 'notes' },
      },
      { effects: ['read'] },
    );
    await disposer.ready;

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('orders_reveal_notes');
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      untrustedContentHint: true,
    });
    disposer();
  });

  it('re-emits a write intent as destructive, exactly like a model write', async () => {
    const intent = defineIntent({
      id: 'orders.stage_note',
      description: 'Propose a note',
      capability: { effect: 'write', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'stage' },
    });

    const disposer = registerViewIntent(
      intent,
      {
        registry: 'control',
        registryPort: controlRegistry(),
        identity: { formId: 'order-form', controlId: 'notes' },
      },
      { effects: ['read', 'write'] },
    );
    await disposer.ready;

    // `write` survives the registrar's own re-resolution as `write` (it is
    // registered at all under an effects policy that omits `destructive`)
    // and is annotated destructive on the way to the browser.
    expect(tools).toHaveLength(1);
    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    disposer();
  });

  it('filters an intent the effects policy does not allow', async () => {
    const readOnly = defineIntent({
      id: 'orders.policy_read',
      description: 'x',
      capability: { effect: 'read', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'reveal' },
    });
    const undeclared = defineIntent({
      id: 'orders.policy_undeclared',
      description: 'x',
      target: { registry: 'control', action: 'clear' },
    });
    const binding = {
      registry: 'control',
      registryPort: controlRegistry(),
      identity: { formId: 'order-form', controlId: 'notes' },
    } as const;

    // Default policy is read-only.
    registerViewIntent(readOnly, binding);
    registerViewIntent(undeclared, binding);
    expect(tools.map((tool) => tool.name)).toEqual(['orders_policy_read']);

    // A fail-closed (undeclared) intent needs an explicit destructive opt-in.
    registerViewIntent(undeclared, binding, {
      effects: ['read', 'write', 'destructive'],
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'orders_policy_read',
      'orders_policy_undeclared',
    ]);
  });

  it('stops executing after disposal', async () => {
    const intent = defineIntent({
      id: 'orders.disposed',
      description: 'x',
      capability: { effect: 'read', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'reveal' },
    });
    const disposer = registerViewIntent(intent, {
      registry: 'control',
      registryPort: controlRegistry(),
      identity: { formId: 'order-form', controlId: 'notes' },
    });
    await disposer.ready;
    disposer();

    await expect(async () => tools[0]?.execute({})).rejects.toThrow(
      /no longer registered/,
    );
  });
});

describe('viewIntentToolName', () => {
  it('flattens dots and dashes into a valid tool name', () => {
    expect(viewIntentToolName('orders.filter-list')).toBe('orders_filter_list');
  });
});

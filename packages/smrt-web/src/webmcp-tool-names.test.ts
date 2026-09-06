/**
 * Cross-path WebMCP tool-name collisions (#2613).
 *
 * A browser tool name is derived on three independent paths that all end at
 * one `document.modelContext`. `registerWebMcpTools` already rejected
 * duplicates within its own prospective set; these cover the collisions
 * ACROSS the paths, which previously reached the host and silently lost a
 * tool. Each asserts BOTH that the collision is refused synchronously and
 * that the diagnostic names the owner that holds the name.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SmrtWebCollectionDefinition } from './index.js';
import { defineIntent, type ViewIntentBinding } from './intents.js';
import {
  registerViewIntent,
  registerWebMcpBespokeTool,
  registerWebMcpTools,
} from './webmcp.js';
import {
  reserveWebMcpToolNames,
  WebMcpToolNameCollisionError,
  webMcpToolNameOwner,
} from './webmcp-tool-names.js';

interface CapturedTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

let tools: CapturedTool[] = [];

/** Install a fresh document + model context, as a new page load would. */
function installModelContext(): void {
  tools = [];
  (globalThis as { document?: unknown }).document = {
    modelContext: newContext(),
  };
}

function newContext(): { registerTool: (tool: CapturedTool) => Promise<void> } {
  return {
    registerTool(tool: CapturedTool) {
      tools.push(tool);
      return Promise.resolve();
    },
  };
}

/**
 * A generated model definition whose sole tool descriptor is a custom
 * `next_page` action on an `orders` model — so its derived tool name is
 * `orders_next_page`, exactly what the intent id `orders.next_page` flattens
 * to. This is the collision `packages/smrt-web/AGENTS.md` documented as a
 * Gotcha before this lock existed.
 */
const ORDERS_DEF: SmrtWebCollectionDefinition = {
  name: 'orders',
  objectRef: '@test/smrt-web:Order',
  className: 'Order',
  endpoint: '/orders',
  idField: 'id',
  actions: ['list', 'next_page'],
  toolDescriptors: [
    {
      name: 'orders_next_page',
      action: 'next_page',
      description: 'Advance the orders table by one page',
      inputSchema: { type: 'object', properties: {} },
      effect: 'read',
      idempotent: true,
      openWorld: false,
    },
    {
      name: 'orders_list',
      action: 'list',
      description: 'List orders',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
} as unknown as SmrtWebCollectionDefinition;

const NEXT_PAGE_INTENT = defineIntent({
  id: 'orders.next_page',
  description: 'Advance the orders table by one page',
  capability: { effect: 'read', idempotent: true, openWorld: false },
  target: { registry: 'control', action: 'reveal' },
});

const BINDING: ViewIntentBinding = {
  registry: 'control',
  registryPort: { execute: async () => ({ ok: true }) },
  identity: { formId: 'orders-form', controlId: 'next-page' },
};

function readTool(name: string) {
  return {
    name,
    description: 'A hand-written browser tool',
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: () => 'ok',
  };
}

/**
 * The six fixed UI tool names as `registerWebMcpUiTools` in
 * `@happyvertical/smrt-svelte` derives them from a configurable prefix. That
 * registrar reserves exactly this way; reproduced here because smrt-web has
 * no dependency on a UI layer.
 */
function reserveUiTools(prefix: string) {
  return reserveWebMcpToolNames(
    [
      `${prefix}list_form_controls`,
      `${prefix}inspect_form_control`,
      `${prefix}execute_form_control`,
      `${prefix}list_data_surfaces`,
      `${prefix}inspect_data_surface`,
      `${prefix}execute_data_surface_control`,
    ],
    'ui',
  );
}

beforeEach(installModelContext);
afterEach(() => {
  (globalThis as { document?: unknown }).document = undefined;
});

describe('generated vs intent', () => {
  it('refuses an intent whose id flattens onto a generated tool name', async () => {
    const generated = registerWebMcpTools([ORDERS_DEF]);
    await generated.ready;
    expect(tools.map((tool) => tool.name)).toEqual([
      'orders_next_page',
      'orders_list',
    ]);

    let thrown: unknown;
    try {
      registerViewIntent(NEXT_PAGE_INTENT, BINDING);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WebMcpToolNameCollisionError);
    const collision = thrown as WebMcpToolNameCollisionError;
    expect(collision.toolName).toBe('orders_next_page');
    expect(collision.owner).toBe('generated');
    expect(collision.requestedBy).toBe('intent');
    expect(collision.message).toContain('"orders_next_page"');
    expect(collision.message).toContain('generated path');
    // The host never saw a seventh registration.
    expect(tools).toHaveLength(2);
  });

  it('refuses a generated set when a live intent already holds one of its names', async () => {
    const intent = registerViewIntent(NEXT_PAGE_INTENT, BINDING);
    await intent.ready;
    expect(tools.map((tool) => tool.name)).toEqual(['orders_next_page']);

    expect(() => registerWebMcpTools([ORDERS_DEF])).toThrow(
      WebMcpToolNameCollisionError,
    );
    try {
      registerWebMcpTools([ORDERS_DEF]);
    } catch (error) {
      expect((error as WebMcpToolNameCollisionError).owner).toBe('intent');
    }

    // Atomic: the non-colliding `orders_list` never reached the browser, and
    // the failed call left no reservation behind.
    expect(tools.map((tool) => tool.name)).toEqual(['orders_next_page']);
    expect(webMcpToolNameOwner('orders_list')).toBeUndefined();
  });

  it('lets the intent register once the generated tools are disposed', async () => {
    const generated = registerWebMcpTools([ORDERS_DEF]);
    await generated.ready;
    generated();

    const intent = registerViewIntent(NEXT_PAGE_INTENT, BINDING);
    await intent.ready;
    expect(tools.map((tool) => tool.name)).toContain('orders_next_page');
  });

  it('does not reserve a name for a tool the effects policy excluded', () => {
    const undeclared = defineIntent({
      id: 'orders.next_page_undeclared',
      description: 'x',
      target: { registry: 'control', action: 'clear' },
    });
    // Default policy is read-only and an undeclared capability is destructive,
    // so nothing registers — and the name must stay available.
    registerViewIntent(undeclared, BINDING);
    expect(tools).toHaveLength(0);
    expect(webMcpToolNameOwner('orders_next_page_undeclared')).toBeUndefined();

    const bespoke = registerWebMcpBespokeTool(
      readTool('orders_next_page_undeclared'),
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      'orders_next_page_undeclared',
    ]);
    bespoke();
  });
});

describe('fixed UI tools vs bespoke, under a custom prefix', () => {
  it('refuses a bespoke name that a custom-prefixed UI tool holds', () => {
    const ui = reserveUiTools('agent_ui_');

    let thrown: unknown;
    try {
      registerWebMcpBespokeTool(readTool('agent_ui_execute_form_control'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WebMcpToolNameCollisionError);
    const collision = thrown as WebMcpToolNameCollisionError;
    expect(collision.toolName).toBe('agent_ui_execute_form_control');
    expect(collision.owner).toBe('ui');
    expect(collision.requestedBy).toBe('bespoke');
    expect(collision.message).toContain('ui path');
    expect(tools).toHaveLength(0);

    // The DEFAULT prefix is not what this Provider mounted, so a tool named
    // for it is unaffected — the point of the lock is that only the runtime
    // prefix decides, and a declaration cannot see it.
    const other = registerWebMcpBespokeTool(
      readTool('smrt_ui_execute_form_control'),
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      'smrt_ui_execute_form_control',
    ]);
    other();
    ui.release();
  });

  it('refuses a UI prefix whose derived names a generated tool already holds', async () => {
    // A Provider mounted with `prefix: 'orders_'` derives
    // `orders_execute_form_control`; a model named `orders` with an
    // `execute_form_control` action derives the very same name. Neither side
    // can see the other's runtime prefix / namespace.
    const collidingGenerated = {
      ...ORDERS_DEF,
      actions: ['execute_form_control'],
      toolDescriptors: [
        {
          name: 'orders_execute_form_control',
          action: 'execute_form_control',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          effect: 'read',
          idempotent: true,
          openWorld: false,
        },
      ],
    } as unknown as SmrtWebCollectionDefinition;
    const generated = registerWebMcpTools([collidingGenerated]);
    await generated.ready;

    let thrown: unknown;
    try {
      reserveUiTools('orders_');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WebMcpToolNameCollisionError);
    const collision = thrown as WebMcpToolNameCollisionError;
    // The third of the six names, so two were already taken when it failed.
    expect(collision.toolName).toBe('orders_execute_form_control');
    expect(collision.owner).toBe('generated');
    expect(collision.requestedBy).toBe('ui');

    // Rolled back all-or-nothing: the two names the failed reservation had
    // already taken are free again rather than stranded.
    expect(webMcpToolNameOwner('orders_list_form_controls')).toBeUndefined();
    expect(webMcpToolNameOwner('orders_inspect_form_control')).toBeUndefined();

    // A corrected prefix mounts cleanly.
    const ui = reserveUiTools('orders_ui_');
    expect(webMcpToolNameOwner('orders_ui_execute_form_control')).toBe('ui');
    ui.release();
  });
});

describe('bespoke vs bespoke and intent vs intent', () => {
  it('names the bespoke owner when two hand-written tools clash', () => {
    const first = registerWebMcpBespokeTool(readTool('reports_export'));
    try {
      registerWebMcpBespokeTool(readTool('reports_export'));
      throw new Error('expected a collision');
    } catch (error) {
      expect(error).toBeInstanceOf(WebMcpToolNameCollisionError);
      expect((error as WebMcpToolNameCollisionError).owner).toBe('bespoke');
    }
    expect(tools).toHaveLength(1);
    first();
  });

  it('names the intent owner when two bound intents derive one name', async () => {
    // `defineIntent` rejects a second id deriving a name an already declared
    // intent derives, so the surviving runtime case is one declaration bound
    // twice — two mounted components sharing an intents sidecar.
    const first = registerViewIntent(NEXT_PAGE_INTENT, BINDING);
    await first.ready;

    try {
      registerViewIntent(NEXT_PAGE_INTENT, BINDING);
      throw new Error('expected a collision');
    } catch (error) {
      expect(error).toBeInstanceOf(WebMcpToolNameCollisionError);
      expect((error as WebMcpToolNameCollisionError).owner).toBe('intent');
    }
    expect(tools).toHaveLength(1);
    first();
  });
});

describe('dispose releases the name', () => {
  it('allows register -> dispose -> re-register under the same name', async () => {
    const first = registerWebMcpBespokeTool(readTool('reports_export'));
    await first.ready;
    first();
    expect(webMcpToolNameOwner('reports_export')).toBeUndefined();

    const second = registerWebMcpBespokeTool(readTool('reports_export'));
    await second.ready;
    expect(tools.map((tool) => tool.name)).toEqual([
      'reports_export',
      'reports_export',
    ]);
    expect(webMcpToolNameOwner('reports_export')).toBe('bespoke');

    // The #2595 re-registration cycle, repeated: a mount/unmount loop must
    // never wedge the name permanently.
    second();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const disposer = registerWebMcpBespokeTool(readTool('reports_export'));
      await disposer.ready;
      disposer();
    }
    expect(webMcpToolNameOwner('reports_export')).toBeUndefined();
  });

  it('is a no-op on a double dispose and cannot revoke a later holder', async () => {
    const first = registerWebMcpBespokeTool(readTool('reports_export'));
    await first.ready;
    first();

    const second = registerWebMcpBespokeTool(readTool('reports_export'));
    await second.ready;
    // A stale handle disposing again must not strip the new holder's claim.
    first();
    expect(webMcpToolNameOwner('reports_export')).toBe('bespoke');
    second();
  });

  it('releases every generated name when the registration is disposed', async () => {
    const generated = registerWebMcpTools([ORDERS_DEF]);
    await generated.ready;
    expect(webMcpToolNameOwner('orders_list')).toBe('generated');
    generated();
    expect(webMcpToolNameOwner('orders_list')).toBeUndefined();
    expect(webMcpToolNameOwner('orders_next_page')).toBeUndefined();
  });
});

describe('lock scope', () => {
  it('is per document, not per module', () => {
    const held = registerWebMcpBespokeTool(readTool('reports_export'));
    expect(webMcpToolNameOwner('reports_export')).toBe('bespoke');

    // A second page (a new document object) shares nothing.
    const otherDocument = { modelContext: newContext() };
    expect(
      webMcpToolNameOwner('reports_export', { document: otherDocument }),
    ).toBeUndefined();
    held();
  });

  it('resets when the host installs a new model context on the same document', async () => {
    const doc = (globalThis as { document?: { modelContext?: unknown } })
      .document as { modelContext: unknown };
    const stranded = registerWebMcpBespokeTool(readTool('reports_export'));
    await stranded.ready;
    // Deliberately never disposed: the tools the old registry held are gone
    // with it, so the names must not stay reserved against the new one.
    doc.modelContext = newContext();

    const rebound = registerWebMcpBespokeTool(readTool('reports_export'));
    await rebound.ready;
    expect(webMcpToolNameOwner('reports_export')).toBe('bespoke');
    rebound();
  });

  it('is an inert no-op off-WebMCP', () => {
    (globalThis as { document?: unknown }).document = undefined;
    const reservation = reserveWebMcpToolNames(['anything'], 'bespoke');
    expect(webMcpToolNameOwner('anything')).toBeUndefined();
    expect(() =>
      reserveWebMcpToolNames(['anything'], 'generated'),
    ).not.toThrow();
    reservation.release();
  });
});

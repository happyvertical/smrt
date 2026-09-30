/**
 * The page's own WebMCP tool registry (#2908): the in-page assistant sees and
 * runs exactly the tools the SMRT registrars hand `document.modelContext`,
 * with or without a native browser context, and the native context keeps
 * receiving every registration.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { defineIntent } from './intents.js';
import { registerViewIntent, registerWebMcpBespokeTool } from './webmcp.js';
import {
  getWebMcpPageToolRegistry,
  installWebMcpPageToolRegistry,
  WebMcpPageToolNotFoundError,
  webMcpPageToolEffect,
} from './webmcp-page-tools.js';
import { markWebMcpProposalTool } from './webmcp-tool-names.js';

const originalDocument = (globalThis as { document?: unknown }).document;

afterEach(() => {
  getWebMcpPageToolRegistry()?.uninstall();
  (globalThis as { document?: unknown }).document = originalDocument;
});

function freshDocument(modelContext?: unknown): Record<string, unknown> {
  const doc: Record<string, unknown> = modelContext ? { modelContext } : {};
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}

describe('installWebMcpPageToolRegistry', () => {
  it('records bespoke registrations even without a native modelContext', async () => {
    freshDocument();
    const registry = installWebMcpPageToolRegistry();
    expect(registry).toBeDefined();
    const dispose = registerWebMcpBespokeTool({
      name: 'invoice_preview',
      description: 'Preview the invoice.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: (args) => JSON.stringify({ ok: true, args }),
    });
    expect(registry?.list()).toEqual([
      expect.objectContaining({
        name: 'invoice_preview',
        effect: 'read',
        owner: 'bespoke',
      }),
    ]);
    expect(await registry?.execute('invoice_preview', { a: 1 })).toBe(
      '{"ok":true,"args":{"a":1}}',
    );
    dispose();
    expect(registry?.list()).toEqual([]);
  });

  it('forwards to the native context and keeps its other members', async () => {
    const nativeTools: string[] = [];
    const native = {
      registerTool(tool: { name: string }) {
        nativeTools.push(tool.name);
      },
      provideContext() {
        return this === native;
      },
    };
    const doc = freshDocument(native);
    const registry = installWebMcpPageToolRegistry();
    registerWebMcpBespokeTool(
      {
        name: 'draft_write',
        description: 'Write a draft.',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false, destructiveHint: false },
        execute: () => 'done',
      },
      { effects: ['read', 'write'] },
    );
    expect(nativeTools).toEqual(['draft_write']);
    expect(registry?.get('draft_write')?.effect).toBe('write');
    const installed = doc.modelContext as { provideContext(): boolean };
    expect(installed.provideContext()).toBe(true);
  });

  it('drops a tool the native context refuses', async () => {
    freshDocument({
      registerTool: () => Promise.reject(new Error('refused')),
    });
    const registry = installWebMcpPageToolRegistry();
    const dispose = registerWebMcpBespokeTool({
      name: 'refused_tool',
      description: 'x',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      execute: () => 'x',
    });
    await expect(dispose.ready).rejects.toThrow('refused');
    expect(registry?.list()).toEqual([]);
  });

  it('is idempotent and restores the previous context on uninstall', () => {
    const native = { registerTool() {} };
    const doc = freshDocument(native);
    const first = installWebMcpPageToolRegistry();
    expect(installWebMcpPageToolRegistry()).toBe(first);
    first?.uninstall();
    expect(doc.modelContext).toBe(native);
    expect(getWebMcpPageToolRegistry()).toBeUndefined();
  });

  it('notifies subscribers and rejects an unknown tool', async () => {
    freshDocument();
    const registry = installWebMcpPageToolRegistry();
    const events: string[] = [];
    registry?.subscribe((event) => events.push(`${event.type}:${event.name}`));
    const dispose = registerWebMcpBespokeTool({
      name: 'ping',
      description: 'x',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      execute: () => 'pong',
    });
    dispose();
    expect(events).toEqual(['registered:ping', 'unregistered:ping']);
    await expect(registry?.execute('ping', {})).rejects.toBeInstanceOf(
      WebMcpPageToolNotFoundError,
    );
  });

  it('is a no-op off-DOM', () => {
    (globalThis as { document?: unknown }).document = undefined;
    expect(installWebMcpPageToolRegistry()).toBeUndefined();
  });
});

describe('proposal brand', () => {
  const writeAnnotations = { readOnlyHint: false, destructiveHint: false };

  it('does not trust a bespoke tool that labels itself an intent', async () => {
    freshDocument();
    const registry = installWebMcpPageToolRegistry();
    registerWebMcpBespokeTool(
      {
        name: 'wire_money',
        description: 'Acts directly.',
        inputSchema: { type: 'object' },
        annotations: writeAnnotations,
        execute: () => 'sent',
      },
      { effects: ['read', 'write'], owner: 'intent' },
    );
    const descriptor = registry?.get('wire_money');
    // The lock label is still reported for diagnostics ...
    expect(descriptor?.owner).toBe('intent');
    // ... but only a branded registration counts as a proposal.
    expect(descriptor?.proposal).toBe(false);
  });

  it('brands a compiled view intent', async () => {
    freshDocument();
    const registry = installWebMcpPageToolRegistry();
    const intent = defineIntent({
      id: 'brandtest.stage_note',
      description: 'Propose a note',
      capability: { effect: 'write', idempotent: true, openWorld: false },
      target: { registry: 'control', action: 'stage' },
    });
    registerViewIntent(
      intent,
      {
        registry: 'control',
        registryPort: { execute: async () => ({ ok: true }) },
        identity: { formId: 'f', controlId: 'c' },
      },
      { effects: ['read', 'write'] },
    );
    const descriptor = registry?.get('brandtest_stage_note');
    expect(descriptor?.owner).toBe('intent');
    expect(descriptor?.proposal).toBe(true);
  });

  it('brands a raw registration only through markWebMcpProposalTool', () => {
    const doc = freshDocument();
    const registry = installWebMcpPageToolRegistry();
    const context = doc.modelContext as {
      registerTool(tool: Record<string, unknown>): void;
    };
    context.registerTool({
      name: 'raw_unbranded',
      description: 'x',
      inputSchema: {},
      annotations: writeAnnotations,
      execute: () => 'x',
    });
    context.registerTool({
      name: 'raw_branded',
      description: 'x',
      inputSchema: {},
      annotations: writeAnnotations,
      execute: markWebMcpProposalTool(() => 'x'),
    });
    expect(registry?.get('raw_unbranded')?.proposal).toBe(false);
    expect(registry?.get('raw_branded')?.proposal).toBe(true);
  });
});

describe('webMcpPageToolEffect', () => {
  it('classifies fail-closed, like the bespoke registrar', () => {
    expect(webMcpPageToolEffect({ readOnlyHint: true })).toBe('read');
    expect(webMcpPageToolEffect({ destructiveHint: false })).toBe('write');
    expect(
      webMcpPageToolEffect({ destructiveHint: true, readOnlyHint: true }),
    ).toBe('destructive');
    expect(webMcpPageToolEffect({ readOnlyHint: false })).toBe('destructive');
    expect(webMcpPageToolEffect(undefined)).toBe('destructive');
  });
});

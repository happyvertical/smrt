import { MessageChannel } from 'node:worker_threads';
import { flushSync, tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiState } from '../src/lib/ai/instance.ts';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import {
  clearSampleContext,
  getSampleContext,
} from '../src/lib/data/sample-context.ts';
import {
  bindPlannerCommandPort,
  connectPlannerCommandPort,
  type PlannerBridgeSnapshot,
} from '../src/lib/planner/bridge.ts';
import { createPlannerController } from '../src/lib/planner/commands/index.ts';
import { resetWorkspace } from '../src/lib/planner/workspace.svelte.ts';

const closers: (() => void)[] = [];
beforeEach(() => {
  cookbookStore.reset();
  clearSampleContext();
});
afterEach(() => {
  for (const close of closers.splice(0)) close();
  cookbookStore.reset();
  clearSampleContext();
});
function setup(
  allowedCommands = ['add_recipes', 'add_features', 'set_name'] as const,
  guide?: import('../src/lib/planner/guide.ts').PlannerGuideHandle,
) {
  const controller = createPlannerController();
  const { port1, port2 } = new MessageChannel();
  const binding = bindPlannerCommandPort({
    port: port1 as unknown as MessagePort,
    controller,
    allowedCommands,
    source: 'external-assistant',
    guide,
  });
  const client = connectPlannerCommandPort(port2 as unknown as MessagePort);
  closers.push(() => {
    client.dispose();
    binding.dispose();
  });
  return { controller, binding, client };
}
const sample = {
  provenance: 'fictional',
  products: [
    { name: 'Research sensor', description: 'Fictional sensor', price: 12000 },
  ],
  customers: ['Sample institute'],
  vendors: ['Sample lab'],
};
const commands = [
  { name: 'add_recipes', input: { ids: ['commerce.customers'] } },
];

describe('dedicated actual Planner command port', () => {
  it('separates bounded literal speech from the full actual application receipt', async () => {
    const { client } = setup();
    const before = await client.snapshot();
    const request = {
      id: 'spoken-receipt',
      generation: before.generation,
      expectedRevision: before.snapshot.revision,
      reply: { reply: 'Untrusted model prose '.repeat(80), commands },
    };
    const result = await client.applyReply(request);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('fictional sample records');
    expect(result.content).toContain(
      'What else would you like your app to do?',
    );
    expect(result.spokenContent).toContain('fictional records');
    expect(result.spokenContent?.split(/\s+/).length).toBeLessThanOrEqual(40);
    expect(result.spokenContent).not.toContain('Untrusted');
    expect((await client.applyReply(request)).spokenContent).toBe(
      result.spokenContent,
    );
    const noChange = await client.applyReply({
      id: 'no-spoken-change',
      generation: before.generation,
      expectedRevision: result.snapshot.revision,
      reply: { reply: 'A current question?', commands: [] },
    });
    expect(noChange.content).toContain('A current question?');
    expect(noChange.spokenContent).toBeUndefined();
    const conflict = await client.applyReply({
      ...request,
      id: 'spoken-conflict',
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.spokenContent).toBeUndefined();
  });

  it('shares the actual app, subscribes manual edits, exposes canonical catalog, attributes receipts and retries once', async () => {
    const { controller, client } = setup();
    const states: PlannerBridgeSnapshot[] = [];
    client.subscribe((value) => states.push(value));
    const before = await client.snapshot();
    const context = await client.context();
    expect(context.catalog.recipes.length).toBeGreaterThan(0);
    expect(context.tools.some((tool) => tool.name === 'add_recipes')).toBe(
      true,
    );
    const input = {
      id: 'one',
      generation: before.generation,
      expectedRevision: before.snapshot.revision,
      commands,
    };
    const result = await client.execute(input);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('external-assistant');
    expect(controller.snapshot().recipes.map((r) => r.id)).toContain(
      'commerce.customers',
    );
    expect(await client.execute(input)).toEqual(result);
    expect(
      (
        await client.execute({
          ...input,
          commands: [{ name: 'set_name', input: { name: 'different' } }],
        })
      ).error?.code,
    ).toBe('conflict');
    cookbookStore.name = 'Manually edited';
    flushSync();
    await tick();
    await client.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(states.at(-1)?.snapshot.app.name).toBe('Manually edited');
    const stale = await client.execute({ ...input, id: 'stale' });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe('conflict');
  });

  it('rejects forbidden commands, invalid atomic batches, malformed/oversize inputs without partial edits', async () => {
    const { client, controller } = setup();
    const before = await client.snapshot();
    const input = {
      id: 'policy',
      generation: before.generation,
      expectedRevision: before.snapshot.revision,
      commands: [...commands, { name: 'reset_theme', input: {} }],
    };
    expect((await client.execute(input)).error?.code).toBe('forbidden');
    expect(controller.snapshot().recipes).toHaveLength(0);
    expect(
      (
        await client.execute({
          ...input,
          id: 'atomic',
          commands: [
            ...commands,
            { name: 'add_features', input: { ids: ['missing:Model'] } },
          ],
        })
      ).ok,
    ).toBe(false);
    expect(controller.snapshot().recipes).toHaveLength(0);
    expect(
      (
        await client.execute({
          ...input,
          id: 'large',
          commands: [{ name: 'set_name', input: { name: 'x'.repeat(40000) } }],
        })
      ).error?.code,
    ).toBe('invalid_input');
    expect(
      (
        await client.execute({
          ...input,
          id: 'unknown',
          commands: [{ name: 'invented', input: {} }],
        })
      ).ok,
    ).toBe(false);
  });

  it('applies hosted commands, samples and coaching without writing any assistant thread', async () => {
    const { client, controller } = setup();
    const before = await client.snapshot();
    const nativeBefore = aiState.session.transport.conversation();
    const reply = {
      reply: 'Claimed model success is replaced by actual receipts.',
      commands,
      sampleContext: sample,
    };
    const input = {
      id: 'reply',
      generation: before.generation,
      expectedRevision: before.snapshot.revision,
      reply,
    };
    const result = await client.applyReply(input);
    expect(result.ok).toBe(true);
    expect(aiState.session.transport.conversation()).toEqual(nativeBefore);
    expect(result.sampleContextApplied).toBe(true);
    expect(result.content).toContain('Added');
    expect(result.content).toContain('fictional sample records');
    expect(result.content).not.toContain('Claimed model success');
    expect(getSampleContext()?.products[0].name).toBe('Research sensor');
    expect(await client.applyReply(input)).toEqual(result);
    expect(
      (
        await client.applyReply({
          ...input,
          reply: {
            ...reply,
            sampleContext: { ...sample, customers: ['different'] },
          },
        })
      ).error?.code,
    ).toBe('conflict');
    expect(controller.snapshot().recipes).toHaveLength(1);
  });

  it('rejects a pending pre-reset hosted reply through the real reset coordinator and rejects disposed calls', async () => {
    const { client, controller, binding } = setup();
    const before = await client.snapshot();
    // Queue the returned inference result but reset before MessagePort dispatch.
    const pending = client.applyReply({
      id: 'inference-before-reset',
      generation: before.generation,
      expectedRevision: before.snapshot.revision,
      reply: { reply: 'Added', commands, sampleContext: sample },
    });
    expect(
      resetWorkspace({
        controller,
        dataSource: { reset: clearSampleContext } as never,
        onreset: binding.invalidate,
      }),
    ).toBe(true);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('stale_generation');
    expect(controller.snapshot().recipes).toHaveLength(0);
    expect(getSampleContext()).toBeUndefined();
    const after = await client.snapshot();
    expect(after.generation).not.toBe(before.generation);
    expect(after.snapshot.revision).toBeGreaterThan(before.snapshot.revision);
    client.dispose();
    await expect(client.snapshot()).rejects.toThrow('disposed');
  });

  it('guides only saved actual additions and refuses forged or stale guide authority', async () => {
    const shown: unknown[] = [];
    let dismissed = 0;
    const { client, binding } = setup(undefined, {
      highlight: async (input) => {
        shown.push(input);
        return {
          ok: true,
          targetId: 'actual-target',
          description: 'Verified guide',
        };
      },
      dismiss: () => {
        dismissed++;
      },
    });
    const before = await client.snapshot();
    expect(
      (
        await client.guide({
          generation: before.generation,
          kind: 'unknown',
        } as never)
      ).ok,
    ).toBe(false);
    expect(
      (
        await client.guide({
          generation: before.generation,
          kind: 'arrival',
          targetId: 'forged',
        } as never)
      ).ok,
    ).toBe(false);
    expect(
      (
        await client.guide({
          generation: before.generation,
          kind: 'addition',
          requestId: 'invented',
        })
      ).ok,
    ).toBe(false);
    expect(shown).toHaveLength(0);
    expect(
      (await client.guide({ generation: before.generation, kind: 'arrival' }))
        .ok,
    ).toBe(true);
    const result = await client.execute({
      id: 'actual-guide',
      generation: before.generation,
      expectedRevision: before.snapshot.revision,
      commands,
    });
    expect(result.ok).toBe(true);
    expect(
      (
        await client.guide({
          generation: before.generation,
          kind: 'addition',
          requestId: 'actual-guide',
        })
      ).ok,
    ).toBe(true);
    expect(shown[1]).toMatchObject({
      kind: 'addition',
      before: before.snapshot,
      result: result.result,
    });
    expect(
      (
        await client.guide({
          generation: before.generation,
          kind: 'addition',
          requestId: 'actual-guide',
        })
      ).ok,
    ).toBe(false);
    binding.invalidate();
    expect(dismissed).toBeGreaterThan(0);
    expect(
      (await client.guide({ generation: before.generation, kind: 'arrival' }))
        .ok,
    ).toBe(false);
  });

  it('bounds receipt memory without evicting and reexecuting earlier request ids', async () => {
    const { client, controller } = setup();
    const state = await client.snapshot();
    for (let n = 0; n < 256; n++) {
      const result = await client.applyReply({
        id: `bounded-${n}`,
        generation: state.generation,
        expectedRevision: state.snapshot.revision,
        reply: { reply: 'What next?' },
      });
      expect(result.ok).toBe(true);
    }
    const tooMany = await client.applyReply({
      id: 'overflow',
      generation: state.generation,
      expectedRevision: state.snapshot.revision,
      reply: { reply: 'Added', commands },
    });
    expect(tooMany.error?.code).toBe('limit_reached');
    expect(controller.snapshot().recipes).toHaveLength(0);
    const retry = await client.applyReply({
      id: 'bounded-0',
      generation: state.generation,
      expectedRevision: state.snapshot.revision,
      reply: { reply: 'What next?' },
    });
    expect(retry.ok).toBe(true);
  });

  it('rejects stale/invalid reply samples before app mutation, including reply-only false claims', async () => {
    const { client, controller } = setup();
    const before = await client.snapshot();
    const input = {
      id: 'invalid-sample',
      generation: before.generation,
      expectedRevision: before.snapshot.revision,
      reply: {
        reply: 'Added',
        commands,
        sampleContext: { provenance: 'real' },
      },
    };
    expect((await client.applyReply(input)).error?.code).toBe('invalid_input');
    expect(controller.snapshot().recipes).toHaveLength(0);
    const result = await client.applyReply({
      ...input,
      id: 'no-change',
      reply: { reply: 'Added the app.' },
    });
    expect(result.content).toContain('Nothing in the app changed.');
    expect(getSampleContext()).toBeUndefined();
  });
});
it('validates contextual controls and current generation at the existing guide boundary', async () => {
  const highlight = vi.fn(async () => ({ ok: true }));
  const { client } = setup(undefined, { highlight, dismiss: vi.fn() });
  const state = await client.snapshot();
  expect(
    await client.guide({
      generation: state.generation,
      kind: 'control',
      control: 'export',
    }),
  ).toEqual({ ok: true });
  expect(highlight).toHaveBeenCalledWith({
    kind: 'control',
    control: 'export',
  });
  expect(
    await client.guide({
      generation: 'stale',
      kind: 'control',
      control: 'build',
    }),
  ).toMatchObject({ ok: false });
  expect(
    await client.guide({
      generation: state.generation,
      kind: 'control',
      control: 'unknown' as 'build',
    }),
  ).toMatchObject({ ok: false });
  expect(highlight).toHaveBeenCalledTimes(1);
});

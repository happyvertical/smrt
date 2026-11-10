import { describe, expect, it } from 'vitest';
import { appliedCoaching } from '../src/lib/assistant/coaching.ts';
import { createBrowserAssistantTransport } from '../src/lib/assistant/transport.ts';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { createHeadlessPlanner } from '../src/lib/core/headless.ts';
import { buildHostPrompt, parseHostReply } from '../src/lib/core/index.ts';
import { clearSampleContext } from '../src/lib/data/sample-context.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

describe('post-execution coaching', () => {
  it('installs fictional vocabulary before the first sample read after native execution', async () => {
    clearSampleContext();
    recipeState.clear();
    const planner = createHeadlessPlanner();
    const source = createMemoryDataSource();
    const transport = createBrowserAssistantTransport({
      model: () => ({
        message: async () =>
          JSON.stringify({
            reply: 'Invented production-ready claim.',
            commands: [
              { name: 'add_recipes', input: { ids: ['commerce.sales'] } },
            ],
            sampleContext: {
              provenance: 'fictional',
              products: [
                {
                  name: 'Demo street deck',
                  description: 'Fictional skateboard deck',
                  price: 6500,
                },
              ],
              customers: ['Demo Rider'],
              vendors: ['Demo Deck Supply'],
            },
          }),
      }),
      store: recipeState,
      recipes,
      controller: planner,
      acceptCommands: true,
    });
    const turn = await transport.sendMessage({
      threadId: 'planner',
      content: 'Build my skateboard shop',
      clientRequestId: 'context-build',
    });
    expect(turn.assistantMessage?.content).toContain(
      'fictional sample records',
    );
    expect(turn.assistantMessage?.content).not.toContain('production-ready');
    const model = getModelByQualifiedName(
      '@happyvertical/smrt-products:Product',
    )?.model;
    if (!model)
      throw new Error('Product is missing from the published catalog');
    const rows = await source.list(model);
    expect(rows[0].name).toBe('Demo street deck');
    clearSampleContext();
  });
  it('uses the applied visible app, preserves partial failure and distinguishes no change', () => {
    const planner = createHeadlessPlanner();
    const before = planner.snapshot();
    const result = planner.run({
      name: 'add_recipes',
      input: { ids: ['commerce.sales'] },
    });
    expect(result.ok).toBe(true);
    const after = planner.snapshot();
    const text = appliedCoaching(before, after, [result], recipes);
    expect(text).toContain('fictional sample records');
    expect(text).toContain('Open ');
    expect(text.match(/\?/g)).toHaveLength(1);
    const repeated = planner.run({
      name: 'add_recipes',
      input: { ids: ['commerce.sales'] },
    });
    expect(
      appliedCoaching(after, planner.snapshot(), [repeated], recipes),
    ).toBe('');
    const refused = planner.run({
      name: 'add_recipes',
      input: { ids: ['missing.recipe'] },
    });
    expect(appliedCoaching(before, after, [result, refused], recipes)).toBe('');
    expect(appliedCoaching(before, before, [refused], recipes)).toBe('');
  });
  it('asks an open-ended question after initial guidance, without choosing the next catalog item', () => {
    const planner = createHeadlessPlanner();
    const before = planner.snapshot();
    const result = planner.run({
      name: 'add_recipes',
      input: { ids: ['commerce.sales'] },
    });
    const text = appliedCoaching(before, planner.snapshot(), [result], recipes);
    expect(text).toContain('Open ');
    expect(text).toContain('What else would you like your app to do?');
    expect(text).not.toContain('Would you like to add');
    // Catalog order and unrelated capabilities grant no authority for a recommendation.
    expect(
      appliedCoaching(
        before,
        planner.snapshot(),
        [result],
        [...recipes].reverse(),
      ),
    ).toBe(text);
  });
  it('does not auto-cycle to another package after an actual followup addition', () => {
    const planner = createHeadlessPlanner();
    planner.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } });
    const before = planner.snapshot();
    const result = planner.run({
      name: 'add_recipes',
      input: { ids: ['commerce.vendors'] },
    });
    expect(result.ok).toBe(true);
    expect(appliedCoaching(before, planner.snapshot(), [result], recipes)).toBe(
      '',
    );
  });
  it('grounds workflow guidance in the supplied catalog and retains command validation', () => {
    const vendor = recipes.find((recipe) => recipe.id === 'commerce.vendors');
    if (!vendor) throw new Error('Published vendor recipe missing');
    const catalog = { recipes: [vendor], cookbooks: [] };
    const planner = createHeadlessPlanner();
    const prompt = buildHostPrompt({
      message: 'I need to keep supplier contact details.',
      snapshot: planner.snapshot(),
      catalog,
    }).system;
    expect(prompt).toContain(vendor.summary);
    expect(prompt).toContain('stated needs');
    expect(prompt).toContain('needs/setup');
    expect(prompt).toContain('package tours');
    expect(prompt).toContain('no invented features');
    const invalid = parseHostReply(
      JSON.stringify({
        reply: 'Added fictional tool',
        commands: [
          { name: 'add_recipes', input: { ids: ['invented.workflow'] } },
        ],
      }),
      catalog,
    );
    expect(invalid.reply.commands ?? []).toEqual([]);
    expect(planner.snapshot().recipes).toEqual([]);
  });
  it('does not invent navigation or repeat initial demo guidance after a feature addition', () => {
    const planner = createHeadlessPlanner();
    planner.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } });
    const before = planner.snapshot();
    const result = planner.run({
      name: 'add_recipes',
      input: { ids: ['commerce.vendors'] },
    });
    expect(
      appliedCoaching(before, planner.snapshot(), [result], recipes),
    ).not.toContain('interactive demo');
    const empty = { ...before, sections: [] };
    expect(
      appliedCoaching({ ...before, recipes: [] }, empty, [result], []),
    ).toBe('');
  });
});

describe('bounded spoken application receipt', () => {
  it('keeps actual initial guidance and question within forty words without model prose', async () => {
    const { appliedSpokenCoaching } = await import(
      '../src/lib/assistant/coaching.ts'
    );
    const planner = createHeadlessPlanner();
    const before = planner.snapshot();
    const result = planner.run({
      name: 'add_recipes',
      input: { ids: ['commerce.sales'] },
    });
    expect(result.ok).toBe(true);
    const spoken = appliedSpokenCoaching(before, planner.snapshot(), [result]);
    expect(spoken.split(/\s+/).length).toBeLessThanOrEqual(40);
    expect(spoken).toContain('fictional records');
    expect(spoken).toContain('edit a record');
    expect(spoken).toContain('Edit arranges the menu and page layout');
    expect(spoken).toContain('What else would you like your app to do?');
    expect(appliedSpokenCoaching(before, before, [])).toBe('');
    const after = planner.snapshot();
    const longNames = structuredClone(after);
    for (const section of longNames.sections)
      section.label = 'Very long section name '.repeat(20);
    const followup = appliedSpokenCoaching(
      { ...after, sections: [] },
      longNames,
      [result],
    );
    const count = longNames.sections
      .filter((section) => !section.hidden)
      .flatMap((section) =>
        section.items.filter((item) => !item.hidden),
      ).length;
    expect(followup).toContain(`Added ${count} menu`);
    expect(followup).not.toContain('Very long');
    expect(followup).not.toContain('What else');
    expect(followup.split(/\s+/).length).toBeLessThanOrEqual(40);
  });
});

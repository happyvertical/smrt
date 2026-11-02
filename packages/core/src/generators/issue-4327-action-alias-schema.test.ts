/**
 * #4327: a custom action parameter typed with a captured local alias must be
 * advertised as the alias's TARGET type, not the literal alias name.
 *
 * `type ActionOptions = Record<string, unknown>` used to reach MCP discovery as
 * the unknown name `ActionOptions`, which `convertTypeToJsonSchema` turned into
 * `type: "string"` — so `tools/list` advertised a required string while the
 * action needs a record. These fixtures go through the real scanner (the test
 * manifest), the registry, and `MCPGenerator`, then call the tool with
 * arguments shaped by the advertised schema.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForeignAlias4327 } from '../__tests__/fixtures/issue-4327-foreign-alias.js';
import { InheritedAlias4327 } from '../__tests__/fixtures/issue-4327-inherited-alias.js';
import { SmrtObject } from '../object.js';
import { smrt } from '../registry.js';
import { MCPGenerator } from './mcp.js';

type ActionOptions4327 = Record<string, unknown>;
type Bag4327 = { name?: string; weight?: number };
type ChainedOptions4327 = ActionOptions4327;
type Label4327 = string;
type Count4327 = number;
// TypeScript rejects a truly cyclic alias, so the compiled fixture uses a
// chain longer than the scanner follows; the scanner's own suite covers the
// cycle itself. Both must fail conservatively, not guess.
type Deep1_4327 = Deep2_4327;
type Deep2_4327 = Deep3_4327;
type Deep3_4327 = Deep4_4327;
type Deep4_4327 = Deep5_4327;
type Deep5_4327 = Deep6_4327;
type Deep6_4327 = Deep7_4327;
type Deep7_4327 = Deep8_4327;
type Deep8_4327 = Deep9_4327;
type Deep9_4327 = string;

@smrt({
  mcp: {
    include: ['createPortfolio', 'annotate', 'loop', 'reweigh'],
  },
})
class Portfolio4327 extends SmrtObject {
  static async createPortfolio(options: ActionOptions4327): Promise<unknown> {
    return { receiver: 'portfolio', options };
  }

  static async annotate(
    payload: ChainedOptions4327,
    label: Label4327,
    count?: Count4327,
  ): Promise<unknown> {
    return { receiver: 'annotate', payload, label, count };
  }

  static async reweigh(options: Bag4327): Promise<unknown> {
    return { receiver: 'reweigh', options };
  }

  static async loop(value: Deep1_4327): Promise<unknown> {
    return { receiver: 'loop', value };
  }
}

async function toolsByName(): Promise<Map<string, Record<string, any>>> {
  const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
  const tools = await generator.generateTools();
  return new Map(tools.map((tool) => [tool.name, tool as any]));
}

describe('#4327 captured aliases in custom action parameter schemas', () => {
  let generator: MCPGenerator;

  beforeEach(() => {
    generator = new MCPGenerator({}, { user: { id: 'test-user' } });
    (generator as any).getCollection = vi.fn().mockReturnValue({
      get: vi.fn(),
    });
  });

  async function call(name: string, args: Record<string, unknown>) {
    const response = await generator.handleToolCall({
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return JSON.parse(response.content[0].text);
  }

  it('advertises a local Record alias as an object and accepts a call that follows it', async () => {
    const tool = (await toolsByName()).get('portfolio4327_createportfolio');
    expect(tool).toBeDefined();
    const options = tool?.inputSchema.properties.options;
    expect(options.type).toBe('object');
    expect(tool?.inputSchema.required).toEqual(['options']);

    const result = await call('portfolio4327_createportfolio', {
      options: { name: 'Growth', weights: { equity: 0.6 } },
    });
    expect(result).toMatchObject({
      receiver: 'portfolio',
      options: { name: 'Growth', weights: { equity: 0.6 } },
    });
  });

  it('advertises an alias to an object literal as an object', async () => {
    const tool = (await toolsByName()).get('portfolio4327_reweigh');
    expect(tool?.inputSchema.properties.options.type).toBe('object');
    const result = await call('portfolio4327_reweigh', {
      options: { name: 'Bond', weight: 0.4 },
    });
    expect(result).toMatchObject({
      receiver: 'reweigh',
      options: { name: 'Bond', weight: 0.4 },
    });
  });

  it('follows chained and primitive aliases', async () => {
    const tool = (await toolsByName()).get('portfolio4327_annotate');
    const properties = tool?.inputSchema.properties;
    expect(properties.payload.type).toBe('object');
    expect(properties.label).toEqual({ type: 'string' });
    expect(properties.count).toEqual({ type: 'number' });
    expect(tool?.inputSchema.required).toEqual(['payload', 'label']);

    const result = await call('portfolio4327_annotate', {
      payload: { a: 1 },
      label: 'x',
      count: 2,
    });
    expect(result).toMatchObject({
      receiver: 'annotate',
      payload: { a: 1 },
      label: 'x',
      count: 2,
    });
  });

  it("resolves a same-named alias through each class's own module", async () => {
    expect(ForeignAlias4327.name).toBe('ForeignAlias4327');
    const tools = await toolsByName();
    expect(
      tools.get('portfolio4327_createportfolio')?.inputSchema.properties.options
        .type,
    ).toBe('object');
    expect(
      tools.get('foreignalias4327_tag')?.inputSchema.properties.label,
    ).toEqual({ type: 'string' });
  });

  it("keeps the declaring module's resolution for an inherited method", async () => {
    expect(InheritedAlias4327.name).toBe('InheritedAlias4327');
    const tools = await toolsByName();
    // `tag` is declared beside `ActionOptions4327 = string`; the subclass's
    // own `ActionOptions4327 = number` applies only to its own `count`.
    expect(
      tools.get('inheritedalias4327_tag')?.inputSchema.properties.label,
    ).toEqual({ type: 'string' });
    expect(
      tools.get('inheritedalias4327_count')?.inputSchema.properties.value,
    ).toEqual({ type: 'number' });
    const result = await call('inheritedalias4327_tag', { label: 'kept' });
    expect(result).toMatchObject({ receiver: 'foreign', label: 'kept' });
  });

  it('fails conservatively on an alias chain it cannot follow instead of guessing string', async () => {
    const tool = (await toolsByName()).get('portfolio4327_loop');
    const value = tool?.inputSchema.properties.value;
    expect(value.type).toBeUndefined();
    expect(String(value.description)).toMatch(/Deep1_4327/);
  });

  it('keeps the class exported for the scanner', () => {
    expect(Portfolio4327.name).toBe('Portfolio4327');
  });
});

/**
 * #3599: generated MCP tool descriptions name the model's display label field,
 * so an assistant knows which field identifies a record ("Acme" -> id).
 */
import { describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { MCPGenerator } from './mcp.js';

@smrt({ display: { label: 'orderNumber' } })
class DisplayLabelOrder extends SmrtObject {
  @field()
  orderNumber: string = '';

  @field()
  name: string = '';
}

@smrt()
class DisplayLabelDefaulted extends SmrtObject {
  @field()
  title: string = '';
}

@smrt()
class DisplayLabelNone extends SmrtObject {
  @field()
  reference: string = '';
}

describe('MCP tool descriptions name the display label (#3599)', () => {
  async function descriptions(className: string): Promise<string[]> {
    const generator = new MCPGenerator();
    const tools = await (
      generator as unknown as {
        generateObjectTools(
          name: string,
          include: () => boolean,
          key?: string,
        ): Promise<Array<{ name: string; description: string }>>;
      }
    ).generateObjectTools(className, () => true);
    return tools
      .filter((tool) => /_(list|get|update|delete|create)$/.test(tool.name))
      .map((tool) => `${tool.name}: ${tool.description}`);
  }

  it('uses the declared label field', async () => {
    expect(DisplayLabelOrder.name).toBe('DisplayLabelOrder');
    const lines = await descriptions('DisplayLabelOrder');
    expect(lines.filter((l) => l.includes('`orderNumber`'))).toHaveLength(4);
    expect(lines.find((l) => l.includes('_create'))).not.toContain('`');
  });

  it('falls back to the first of name/title/label/code', async () => {
    expect(DisplayLabelDefaulted.name).toBe('DisplayLabelDefaulted');
    const lines = await descriptions('DisplayLabelDefaulted');
    expect(lines.find((l) => l.includes('_list'))).toContain(
      'Records are identified by their `title` field.',
    );
  });

  it('says nothing when the model has no label field', async () => {
    expect(DisplayLabelNone.name).toBe('DisplayLabelNone');
    const lines = await descriptions('DisplayLabelNone');
    expect(lines.every((l) => !l.includes('identified by'))).toBe(true);
    expect(ObjectRegistry.getConfig('DisplayLabelNone')).toBeDefined();
  });
});

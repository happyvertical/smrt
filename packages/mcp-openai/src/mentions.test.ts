import { createMcpWorkflowTool } from '@happyvertical/smrt-app-mcp';
import { describe, expect, it } from 'vitest';
import {
  mentionQuery,
  openAiMentionItems,
  withOpenAiMentionSearch,
} from './mentions.js';

describe('OpenAI composer mentions', () => {
  it('accepts bounded opaque resource handles only', () => {
    expect(mentionQuery({ query: '' })).toBe('');
    expect(
      openAiMentionItems([
        {
          type: 'resource',
          resourceUri: 'smrt://items/opaque-1',
          title: 'Owned item',
          subtitle: 'Synthetic',
        },
      ]),
    ).toEqual([
      {
        type: 'resource',
        resourceUri: 'smrt://items/opaque-1',
        title: 'Owned item',
        subtitle: 'Synthetic',
      },
    ]);
  });
  it('rejects forged fields, IDs and result amplification before selection authorization', () => {
    expect(() => mentionQuery({ query: 'x', tenantId: 'forged' })).toThrow();
    expect(() => mentionQuery({ query: 'x'.repeat(257) })).toThrow();
    expect(() =>
      openAiMentionItems([
        {
          type: 'resource',
          resourceUri: 'smrt://x',
          title: 'x',
          id: 'guessed',
        },
      ]),
    ).toThrow();
    expect(() =>
      openAiMentionItems(
        Array.from({ length: 26 }, () => ({
          type: 'resource',
          resourceUri: 'smrt://x',
          title: 'x',
        })),
      ),
    ).toThrow();
  });
  it('advertises the pinned app-only metadata without adding an authority path', () => {
    const definition = withOpenAiMentionSearch({
      name: 'mention_search',
      description: 'Search',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      effect: 'read',
      idempotent: true,
      openWorld: false,
      execute: () => ({ content: [], structuredContent: { items: [] } }),
    });
    expect(createMcpWorkflowTool(definition).tool._meta).toMatchObject({
      'openai/extensions': { 'mentions/search': {} },
      ui: { visibility: ['app'] },
    });
  });
});

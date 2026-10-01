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
  it('preserves bounded icon presentation and rejects malformed metadata', () => {
    const item = {
      type: 'resource',
      resourceUri: 'smrt://items/opaque',
      title: 'Owned',
      icons: [
        {
          src: 'https://example.test/icon.png',
          mimeType: 'image/png',
          sizes: ['32x32'],
          theme: 'dark',
        },
      ],
    };
    expect(openAiMentionItems([item])).toEqual([item]);
    for (const metadata of [
      { sizes: '32x32' },
      { sizes: [null] },
      { sizes: [''] },
      { sizes: ['x'.repeat(33)] },
      { sizes: Array(9).fill('32x32') },
      { theme: 'unknown' },
    ]) {
      expect(() =>
        openAiMentionItems([
          { ...item, icons: [{ src: 'icon.png', ...metadata }] },
        ]),
      ).toThrow();
    }
  });
  it('publishes a closed bounded resource and icon descriptor for consumers', () => {
    const definition = withOpenAiMentionSearch({
      name: 'search',
      description: 'Search',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      effect: 'read',
      idempotent: true,
      openWorld: false,
      execute: () => ({ content: [], structuredContent: { items: [] } }),
    });
    const descriptor = createMcpWorkflowTool(definition).tool.outputSchema;
    expect(descriptor).toMatchObject({
      properties: {
        items: {
          maxItems: 25,
          items: {
            type: 'object',
            required: ['type', 'resourceUri', 'title'],
            additionalProperties: false,
            properties: {
              type: { const: 'resource' },
              resourceUri: { type: 'string', minLength: 1, maxLength: 2048 },
              title: { type: 'string', minLength: 1, maxLength: 512 },
              subtitle: { type: 'string', minLength: 1, maxLength: 512 },
              icons: {
                maxItems: 8,
                items: {
                  type: 'object',
                  required: ['src'],
                  additionalProperties: false,
                  properties: {
                    src: { minLength: 1, maxLength: 2048 },
                    mimeType: { minLength: 1, maxLength: 128 },
                    sizes: {
                      type: 'array',
                      maxItems: 8,
                      items: { type: 'string', minLength: 1, maxLength: 32 },
                    },
                    theme: { enum: ['light', 'dark'] },
                  },
                },
              },
            },
          },
        },
      },
    });
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

it('rejects mention list accessors without invoking them', () => {
  let calls = 0;
  const value = Object.defineProperty([], '0', { get: () => calls++ });
  expect(() => openAiMentionItems(value)).toThrow();
  expect(calls).toBe(0);
});

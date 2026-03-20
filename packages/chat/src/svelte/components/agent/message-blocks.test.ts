import { describe, expect, it } from 'vitest';
import { parseAgentMessageBlocks } from './message-blocks';

describe('parseAgentMessageBlocks', () => {
  it('preserves fenced markdown blocks as readable content', () => {
    expect(
      parseAgentMessageBlocks(
        'Here is a draft:\n```markdown\n# Heading\n\nBody copy\n```\nThanks.',
      ),
    ).toEqual([
      { type: 'text', content: 'Here is a draft:\n' },
      { type: 'markdown', content: '# Heading\n\nBody copy' },
      { type: 'text', content: '\nThanks.' },
    ]);
  });

  it('extracts field updates from json blocks', () => {
    expect(
      parseAgentMessageBlocks(
        '```json\n{"fields":{"title":"New title","body":"Updated body"}}\n```',
      ),
    ).toEqual([
      {
        type: 'fields',
        fields: { title: 'New title', body: 'Updated body' },
      },
    ]);
  });

  it('falls back to plain text for invalid json blocks', () => {
    expect(parseAgentMessageBlocks('```json\n{not valid json}\n```')).toEqual([
      { type: 'text', content: '```json\n{not valid json}\n```' },
    ]);
  });

  it('supports windows newlines and whitespace after the language tag', () => {
    expect(
      parseAgentMessageBlocks(
        'Intro\r\n```markdown   \r\n# Heading\r\n\r\nBody copy\r\n```\r\nDone',
      ),
    ).toEqual([
      { type: 'text', content: 'Intro\r\n' },
      { type: 'markdown', content: '# Heading\r\n\r\nBody copy' },
      { type: 'text', content: '\r\nDone' },
    ]);
  });
});

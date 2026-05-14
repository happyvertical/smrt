import { describe, expect, it } from 'vitest';
import { sanitizeContentEditorAssistantFieldUpdates } from './content-editor-assistant';

describe('content editor assistant utilities', () => {
  it('allows consumers to extend AI field update allow-lists safely', () => {
    expect(
      sanitizeContentEditorAssistantFieldUpdates(
        {
          title: 'Headline',
          customSummary: 'Extended summary',
          customStatus: 'ready',
          tenantId: 'tenant-b',
          invalidCustomStatus: 'nope',
        },
        {
          textFields: ['customSummary'],
          enumFields: {
            customStatus: ['ready', 'blocked'],
            invalidCustomStatus: ['ok'],
          },
        },
      ),
    ).toEqual({
      title: 'Headline',
      customSummary: 'Extended summary',
      customStatus: 'ready',
    });
  });
});

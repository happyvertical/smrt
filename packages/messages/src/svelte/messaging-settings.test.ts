import { describe, expect, it } from 'vitest';
import { coerceMessagingProviderValues } from './messaging-settings.js';

describe('coerceMessagingProviderValues', () => {
  it('omits unset optional fields before coercing typed values', () => {
    expect(
      coerceMessagingProviderValues({ chatId: '123', secure: 'true' }, [
        { id: 'chatId', label: 'Chat ID', type: 'string' },
        { id: 'threadId', label: 'Thread ID', type: 'number' },
        { id: 'secure', label: 'Secure', type: 'boolean' },
      ]),
    ).toEqual({ chatId: '123', secure: true });
  });

  it('coerces supplied number fields', () => {
    expect(
      coerceMessagingProviderValues({ threadId: '42' }, [
        { id: 'threadId', label: 'Thread ID', type: 'number' },
      ]),
    ).toEqual({ threadId: 42 });
  });
});

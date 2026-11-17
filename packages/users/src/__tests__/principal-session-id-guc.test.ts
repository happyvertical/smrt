import { describe, expect, it } from 'vitest';
import { resolvePostgresSessionIdValue } from '../services/SessionPermissionContext.js';

describe('resolvePostgresSessionIdValue', () => {
  it('keeps smrt.session_id empty for a principal run carrying a sessionId label', () => {
    expect(
      resolvePostgresSessionIdValue({ session: null, sessionId: 'sess-1' }),
    ).toBe('');
  });

  it('publishes the id of a loaded session', () => {
    expect(
      resolvePostgresSessionIdValue({
        session: {} as never,
        sessionId: 'sess-1',
      }),
    ).toBe('sess-1');
  });

  it('is empty when there is no session at all', () => {
    expect(
      resolvePostgresSessionIdValue({ session: null, sessionId: null }),
    ).toBe('');
  });
});

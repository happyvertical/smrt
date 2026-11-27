import { describe, expect, it } from 'vitest';
import {
  type AuditWriter,
  GUEST_AUDIT_ACTOR,
  guestCreateAuditContext,
  requireAuditOptions,
} from '../audit.js';

const writer: AuditWriter = async () => {};

describe('requireAuditOptions guest actor', () => {
  it('refuses a bare guest identity: only the guest create pipeline can mint the marker', () => {
    const msg = 'authenticated actorId';
    expect(() =>
      requireAuditOptions({ callerKind: 'guest', writer } as never),
    ).toThrow(msg);
    expect(() =>
      requireAuditOptions({ actorId: 'u', writer }, { callerKind: 'guest' }),
    ).toThrow(msg);
    // A copy of the real identity is not the real identity.
    expect(() =>
      requireAuditOptions(
        { writer } as never,
        { ...guestCreateAuditContext() } as never,
      ),
    ).toThrow(msg);
  });

  it('accepts the marker through the typed guest variant', () => {
    const resolved = requireAuditOptions(
      { writer } as never,
      guestCreateAuditContext(),
    );
    expect(resolved.callerKind).toBe('guest');
    expect(resolved.actorId).toBe(GUEST_AUDIT_ACTOR);
  });

  it('lets a guest context override a user default and vice versa', () => {
    const guest = requireAuditOptions(
      { actorId: 'user-1', writer },
      guestCreateAuditContext(),
    );
    expect(guest.callerKind).toBe('guest');
    expect(guest.actorId).toBe(GUEST_AUDIT_ACTOR);
    const user = requireAuditOptions({ callerKind: 'guest', writer } as never, {
      actorId: 'user-2',
    });
    expect(user).toMatchObject({ callerKind: 'user', actorId: 'user-2' });
  });

  it('rejects the reserved constant supplied as a string actorId', () => {
    const msg = 'authenticated actorId';
    expect(() =>
      requireAuditOptions({ actorId: GUEST_AUDIT_ACTOR, writer }),
    ).toThrow(msg);
    expect(() =>
      requireAuditOptions(
        { actorId: 'user-1', writer },
        { actorId: ` ${GUEST_AUDIT_ACTOR} ` },
      ),
    ).toThrow(msg);
    expect(() =>
      requireAuditOptions({
        actorId: GUEST_AUDIT_ACTOR,
        callerKind: 'user',
        writer,
      }),
    ).toThrow(msg);
  });

  it('rejects a guest context that also carries an actor string', () => {
    expect(() =>
      requireAuditOptions({
        callerKind: 'guest',
        actorId: 'user-1',
        writer,
      } as never),
    ).toThrow('authenticated actorId');
  });

  it('still rejects blank actors and missing writers', () => {
    expect(() => requireAuditOptions({ actorId: '  ', writer })).toThrow(
      'authenticated actorId',
    );
    expect(() => requireAuditOptions({ actorId: 'u' } as never)).toThrow(
      'writer',
    );
    expect(() => requireAuditOptions(undefined)).toThrow('writer');
  });
});

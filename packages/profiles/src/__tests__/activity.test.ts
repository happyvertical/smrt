import { describe, expect, it } from 'vitest';
import { auditActivityEntries } from '../activity';
import { AuditLog } from '../models/AuditLog';

describe('auditActivityEntries', () => {
  it('projects authorized audit records newest first without inventing a resource link', () => {
    const older = new AuditLog({
      profileId: 'a',
      action: 'created',
      resourceType: 'Job',
      resourceId: '1',
    });
    older.id = 'older';
    older.occurredAt = new Date('2026-01-01T00:00:00Z');
    const newer = new AuditLog({
      profileId: 'b',
      action: 'updated',
      resourceType: 'Job',
      resourceId: '1',
      reason: 'Approved',
    });
    newer.id = 'newer';
    newer.occurredAt = new Date('2026-02-01T00:00:00Z');
    expect(auditActivityEntries([older, newer])).toEqual([
      expect.objectContaining({
        id: 'newer',
        title: 'b · updated',
        detail: 'Approved',
        href: null,
      }),
      expect.objectContaining({
        id: 'older',
        title: 'a · created',
        detail: 'Job / 1',
        href: null,
      }),
    ]);
  });
});

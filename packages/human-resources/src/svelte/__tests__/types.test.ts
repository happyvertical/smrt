/**
 * Pure helpers behind the HR components: UTC day arithmetic on calendar
 * dates, status → label/badge mapping, adapters from service results, and the
 * employee form's normalization.
 */
import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  employmentStatusBadgeKey,
  employmentStatusLabelKey,
  expiryDistance,
  isCalendarDate,
  isWorkerType,
  qualificationExpiryState,
  qualificationStateBadgeKey,
  qualificationStateLabelKey,
  sortBySoonestExpiry,
  toEmployeeFormInitial,
  toEmployeeView,
  toExpiringQualificationView,
  toPersonQualificationView,
  validateEmployeeForm,
} from '../types.js';

describe('daysUntil', () => {
  it('counts whole days between calendar dates', () => {
    expect(daysUntil('2026-10-03', '2026-10-03')).toBe(0);
    expect(daysUntil('2026-10-03', '2026-10-04')).toBe(1);
    expect(daysUntil('2026-10-03', '2026-10-02')).toBe(-1);
  });

  it('crosses month and year boundaries', () => {
    expect(daysUntil('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysUntil('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysUntil('2026-01-01', '2027-01-01')).toBe(365);
    expect(daysUntil('2027-01-01', '2026-12-25')).toBe(-7);
  });

  it('counts the leap day', () => {
    expect(daysUntil('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysUntil('2027-02-28', '2027-03-01')).toBe(1);
    expect(daysUntil('2028-01-01', '2029-01-01')).toBe(366);
  });

  it('is not moved by daylight saving changes', () => {
    // Both transitions in zones that observe them; UTC math ignores them.
    expect(daysUntil('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysUntil('2026-10-31', '2026-11-02')).toBe(2);
    expect(daysUntil('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('rejects values that are not real calendar dates', () => {
    expect(() => daysUntil('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => daysUntil('2026-10-03', '03/10/2026')).toThrow(RangeError);
  });
});

describe('isCalendarDate and isWorkerType', () => {
  it('accepts only real YYYY-MM-DD dates', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-1')).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
  });

  it('accepts lowercase kebab-case worker types', () => {
    expect(isWorkerType('employee')).toBe(true);
    expect(isWorkerType('seasonal-worker')).toBe(true);
    expect(isWorkerType('Seasonal Worker')).toBe(false);
    expect(isWorkerType('')).toBe(false);
  });
});

describe('status mapping', () => {
  it('maps each employment status to a label key and badge key', () => {
    expect(employmentStatusLabelKey('active')).toBe(
      'human_resources.employee_list.status_active',
    );
    expect(employmentStatusLabelKey('on-leave')).toBe(
      'human_resources.employee_list.status_on_leave',
    );
    expect(employmentStatusLabelKey('ended')).toBe(
      'human_resources.employee_list.status_ended',
    );
    expect(employmentStatusBadgeKey('active')).toBe('active');
    expect(employmentStatusBadgeKey('on-leave')).toBe('pending');
    expect(employmentStatusBadgeKey('ended')).toBe('inactive');
  });

  it('flags a valid qualification inside the expiring-soon window, inclusive', () => {
    const valid = (daysUntilExpiry: number | null) =>
      qualificationExpiryState({ status: 'valid', daysUntilExpiry }, 30);
    expect(valid(31)).toBe('valid');
    expect(valid(30)).toBe('expiring-soon');
    expect(valid(0)).toBe('expiring-soon');
    expect(valid(-1)).toBe('expired');
    expect(valid(null)).toBe('valid');
  });

  it('defaults the expiring-soon window to 30 days', () => {
    expect(
      qualificationExpiryState({ status: 'valid', daysUntilExpiry: 30 }),
    ).toBe('expiring-soon');
    expect(
      qualificationExpiryState({ status: 'valid', daysUntilExpiry: 31 }),
    ).toBe('valid');
  });

  it('keeps a non-valid status whatever the day count', () => {
    for (const status of [
      'expired',
      'suspended',
      'revoked',
      'not-yet-issued',
    ] as const)
      expect(qualificationExpiryState({ status, daysUntilExpiry: 5 })).toBe(
        status,
      );
  });

  it('maps each expiry state to a label key and badge key', () => {
    expect(qualificationStateLabelKey('expiring-soon')).toBe(
      'human_resources.person_qualifications.state_expiring_soon',
    );
    expect(qualificationStateLabelKey('not-yet-issued')).toBe(
      'human_resources.person_qualifications.state_not_yet_issued',
    );
    expect(qualificationStateBadgeKey('valid')).toBe('success');
    expect(qualificationStateBadgeKey('expiring-soon')).toBe('warning');
    expect(qualificationStateBadgeKey('expired')).toBe('error');
    expect(qualificationStateBadgeKey('revoked')).toBe('error');
    expect(qualificationStateBadgeKey('suspended')).toBe('pending');
    expect(qualificationStateBadgeKey('not-yet-issued')).toBe('inactive');
  });

  it('describes how far away an expiry is', () => {
    expect(expiryDistance(0)).toEqual({
      key: 'human_resources.expiry.today',
      days: 0,
    });
    expect(expiryDistance(1).key).toBe('human_resources.expiry.in_one_day');
    expect(expiryDistance(12)).toEqual({
      key: 'human_resources.expiry.in_days',
      days: 12,
    });
    expect(expiryDistance(-1).key).toBe('human_resources.expiry.one_day_ago');
    expect(expiryDistance(-9)).toEqual({
      key: 'human_resources.expiry.days_ago',
      days: 9,
    });
  });
});

describe('adapters', () => {
  const employment = {
    id: 'emp-1',
    employeeNumber: 'E-100',
    position: 'Carpenter',
    workerType: 'apprentice',
    status: 'on-leave' as const,
    userId: 'user-1',
  };

  it('adapts an employment to a list row with the host name and start date', () => {
    expect(toEmployeeView(employment, 'Ada Lovelace', '2025-04-01')).toEqual({
      id: 'emp-1',
      displayName: 'Ada Lovelace',
      employeeNumber: 'E-100',
      position: 'Carpenter',
      workerType: 'apprentice',
      status: 'on-leave',
      startedOn: '2025-04-01',
      endsOn: null,
    });
  });

  it('carries the last day employed when the host passes a recorded end', () => {
    expect(
      toEmployeeView(
        { ...employment, status: 'ended' },
        'Ada Lovelace',
        '2025-04-01',
        '2026-12-31',
      ),
    ).toMatchObject({ status: 'ended', endsOn: '2026-12-31' });
  });

  it('adapts an employment to the form initial values', () => {
    expect(toEmployeeFormInitial(employment)).toEqual({
      employeeNumber: 'E-100',
      workerType: 'apprentice',
      position: 'Carpenter',
      userId: 'user-1',
    });
    expect(
      toEmployeeFormInitial({ ...employment, userId: undefined }).userId,
    ).toBeNull();
  });

  const row = {
    held: {
      id: 'held-1',
      issuedOn: '2025-11-01',
      expiresOn: '2026-11-01',
      certificateNumber: 'FA-77',
    },
    qualification: {
      name: 'First aid',
      kind: 'certification' as const,
      issuingBody: 'Red Cross',
    },
    status: 'valid' as const,
  };

  it('adapts a listForProfile row and counts days to expiry from today', () => {
    expect(toPersonQualificationView(row, '2026-10-03')).toEqual({
      id: 'held-1',
      name: 'First aid',
      kind: 'certification',
      issuingBody: 'Red Cross',
      certificateNumber: 'FA-77',
      issuedOn: '2025-11-01',
      expiresOn: '2026-11-01',
      status: 'valid',
      daysUntilExpiry: 29,
    });
  });

  it('leaves the day count null for a qualification that never expires', () => {
    const view = toPersonQualificationView(
      { ...row, held: { ...row.held, expiresOn: null } },
      '2026-10-03',
    );
    expect(view.expiresOn).toBeNull();
    expect(view.daysUntilExpiry).toBeNull();
  });

  it('adapts an expiring held qualification with host-supplied names', () => {
    expect(
      toExpiringQualificationView(
        row.held,
        'Ada Lovelace',
        'First aid',
        '2026-12-31',
      ),
    ).toEqual({
      id: 'held-1',
      displayName: 'Ada Lovelace',
      qualificationName: 'First aid',
      expiresOn: '2026-11-01',
      daysUntilExpiry: -60,
    });
    expect(() =>
      toExpiringQualificationView(
        { ...row.held, expiresOn: null },
        'Ada',
        'First aid',
        '2026-10-03',
      ),
    ).toThrow(RangeError);
  });

  it('sorts by soonest expiry without changing the input', () => {
    const items = [
      {
        id: 'c',
        displayName: 'Cy',
        qualificationName: 'Forklift',
        expiresOn: '2026-10-20',
        daysUntilExpiry: 17,
      },
      {
        id: 'a',
        displayName: 'Bo',
        qualificationName: 'First aid',
        expiresOn: '2026-10-05',
        daysUntilExpiry: 2,
      },
      {
        id: 'b',
        displayName: 'Al',
        qualificationName: 'First aid',
        expiresOn: '2026-10-05',
        daysUntilExpiry: 2,
      },
    ];
    expect(sortBySoonestExpiry(items).map((item) => item.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(items.map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('validateEmployeeForm', () => {
  it('trims a new hire and nulls blank optional fields', () => {
    expect(
      validateEmployeeForm(
        {
          employeeNumber: '  E-100 ',
          workerType: 'contractor',
          position: '   ',
          startedOn: '2026-10-05',
          userId: '',
        },
        true,
      ),
    ).toEqual({
      ok: true,
      values: {
        employeeNumber: 'E-100',
        workerType: 'contractor',
        position: null,
        userId: null,
        startedOn: '2026-10-05',
        effectiveOn: null,
      },
    });
  });

  it('needs an effective date, and no start date, for an edit', () => {
    expect(
      validateEmployeeForm(
        {
          employeeNumber: 'E-100',
          workerType: 'seasonal-worker',
          position: 'Foreman',
          startedOn: '',
          effectiveOn: ' 2026-11-01 ',
          userId: 'user-9',
        },
        false,
      ),
    ).toEqual({
      ok: true,
      values: {
        employeeNumber: 'E-100',
        workerType: 'seasonal-worker',
        position: 'Foreman',
        userId: 'user-9',
        startedOn: null,
        effectiveOn: '2026-11-01',
      },
    });
    for (const effectiveOn of [undefined, '', '2026-02-30', '01/11/2026'])
      expect(
        validateEmployeeForm(
          { employeeNumber: 'E-100', workerType: 'employee', effectiveOn },
          false,
        ),
      ).toEqual({ ok: false, invalid: ['effectiveOn'] });
  });

  it('names every field that fails', () => {
    expect(
      validateEmployeeForm(
        { employeeNumber: ' ', workerType: 'Bad Type' },
        true,
      ),
    ).toEqual({
      ok: false,
      invalid: ['employeeNumber', 'workerType', 'startedOn'],
    });
    expect(
      validateEmployeeForm(
        {
          employeeNumber: 'E-1',
          workerType: 'employee',
          startedOn: '2026-02-30',
        },
        true,
      ),
    ).toEqual({ ok: false, invalid: ['startedOn'] });
  });
});

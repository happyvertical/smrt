import { describe, expect, it } from 'vitest';
import {
  type DatedLabourCommercialInput,
  DatedLabourCommercialResolver,
  ServiceTimeEntry,
} from '../index.js';

function input(): DatedLabourCommercialInput {
  return {
    tenantId: 'tenant-one',
    participantProfileId: 'worker-one',
    workDate: '2024-02-29',
    currency: 'CAD',
    billable: true,
    schedule: [
      {
        effectiveFrom: '2024-01-01',
        effectiveUntil: '2024-03-01',
        currency: 'CAD',
        customer: { id: 'customer', version: 'c1', rateMinor: '12345' },
        wage: { id: 'wage', version: 'w2', rateMinor: '6000' },
        burden: { id: 'burden', version: 'b3', rateMinor: '1000' },
      },
    ],
  };
}
function entry(hours = '1.0005') {
  return Object.assign(new ServiceTimeEntry(), {
    tenantId: 'tenant-one',
    participantProfileId: 'worker-one',
    participantKind: 'human',
    durationSeconds: null,
    evidence: JSON.stringify([
      { kind: '@happyvertical/smrt-timesheets:duration-hours', hours },
    ]),
  });
}

describe('DatedLabourCommercialResolver public contract', () => {
  it('uses exact decimals and separate customer/wage/burden facts', async () => {
    const resolver = new DatedLabourCommercialResolver(input());
    const time = entry();
    const client = await resolver.priceClient(time);
    const provider = await resolver.compensateProvider(time);
    expect(client.amount).toBe(12351);
    expect(provider.amount).toBe(7004);
    expect(client.terms).toEqual({
      workDate: '2024-02-29',
      effectiveFrom: '2024-01-01',
      effectiveUntil: '2024-03-01',
      currency: 'CAD',
      billable: true,
      quantity: { hours: '1.0005' },
      rounding: 'half-up-per-component',
      customer: { id: 'customer', version: 'c1', rateMinor: '12345' },
    });
    expect(provider.terms.wage).toEqual({
      id: 'wage',
      version: 'w2',
      rateMinor: '6000',
      amount: 6003,
    });
    expect(provider.terms.burden).toEqual({
      id: 'burden',
      version: 'b3',
      rateMinor: '1000',
      amount: 1001,
    });
  });

  it('accepts explicit zero rates and the exact safe-integer boundary', async () => {
    const config = input();
    config.schedule[0].customer.rateMinor = '0';
    config.schedule[0].wage.rateMinor = '9007199254740991';
    config.schedule[0].burden.rateMinor = '0';
    const resolver = new DatedLabourCommercialResolver(config);
    expect((await resolver.priceClient(entry('1'))).amount).toBe(0);
    expect((await resolver.compensateProvider(entry('1'))).amount).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    config.schedule[0].wage.version = '';
    expect(() => new DatedLabourCommercialResolver(config)).toThrow(
      /Rate version/,
    );
  });

  it('uses rational seconds and rounds fractional minor-unit hourly rates half up', async () => {
    const config = input();
    config.schedule[0].customer.rateMinor = '1800';
    config.schedule[0].wage.rateMinor = '0.5';
    config.schedule[0].burden.rateMinor = '0.5';
    const resolver = new DatedLabourCommercialResolver(config);
    const time = entry();
    time.evidence = '[]';
    time.durationSeconds = 1;
    expect((await resolver.priceClient(time)).amount).toBe(1);
    time.durationSeconds = 3600;
    expect((await resolver.compensateProvider(time)).amount).toBe(2);
  });

  it('retains compensation for nonbillable work and copies caller input and outputs', async () => {
    const config = input();
    config.billable = false;
    const resolver = new DatedLabourCommercialResolver(config);
    config.billable = true;
    config.schedule[0].wage.rateMinor = '9999';
    const time = entry();
    const provider = await resolver.compensateProvider(time);
    (provider.terms.wage as Record<string, unknown>).rateMinor = '1';
    expect((await resolver.priceClient(time)).amount).toBe(0);
    expect((await resolver.compensateProvider(time)).amount).toBe(7004);
  });

  it('selects adjacent periods at the inclusive start/exclusive end, independent of order', async () => {
    const config = input();
    config.workDate = '2024-03-01';
    config.schedule = [
      {
        ...config.schedule[0],
        effectiveFrom: '2024-03-01',
        effectiveUntil: undefined,
        customer: { id: 'new', version: 'v2', rateMinor: '1' },
      },
      ...config.schedule,
    ];
    expect(
      (await new DatedLabourCommercialResolver(config).priceClient(entry('1')))
        .terms.customer,
    ).toEqual({ id: 'new', version: 'v2', rateMinor: '1' });
  });

  it.each([
    '2023-02-29',
    '2024-02-30',
    '2024-13-01',
    '2024-1-01',
    '2024-01-01T00:00:00Z',
    '0000-01-01',
    '',
  ])('rejects invalid calendar date %s', (workDate) => {
    expect(
      () => new DatedLabourCommercialResolver({ ...input(), workDate }),
    ).toThrow(/calendar date/);
  });

  it('rejects missing, overlapping, duplicate and reversed schedules and currency mismatch', () => {
    const config = input();
    const period = config.schedule[0];
    expect(
      () => new DatedLabourCommercialResolver({ ...config, schedule: [] }),
    ).toThrow(/schedule/);
    expect(
      () =>
        new DatedLabourCommercialResolver({
          ...config,
          workDate: '2024-03-01',
        }),
    ).toThrow(/No applicable/);
    expect(
      () =>
        new DatedLabourCommercialResolver({
          ...config,
          schedule: [period, period],
        }),
    ).toThrow(/ambiguous/);
    expect(
      () =>
        new DatedLabourCommercialResolver({
          ...config,
          schedule: [
            period,
            {
              ...period,
              effectiveFrom: '2024-02-28',
              effectiveUntil: undefined,
            },
          ],
        }),
    ).toThrow(/Overlapping/);
    expect(
      () =>
        new DatedLabourCommercialResolver({
          ...config,
          schedule: [{ ...period, effectiveUntil: period.effectiveFrom }],
        }),
    ).toThrow(/positive length/);
    expect(
      () => new DatedLabourCommercialResolver({ ...config, currency: 'USD' }),
    ).toThrow(/currency mismatch/);
    expect(
      () => new DatedLabourCommercialResolver({ ...config, currency: 'cad' }),
    ).toThrow(/Currency/);
    expect(
      () =>
        new DatedLabourCommercialResolver({
          ...config,
          billable: undefined as unknown as boolean,
        }),
    ).toThrow(/Billable/);
    expect(
      () => new DatedLabourCommercialResolver({ ...config, tenantId: '' }),
    ).toThrow(/Tenant/);
  });

  it.each([
    '-1',
    '1e3',
    'NaN',
    'Infinity',
    '9007199254740992',
    '0.0000000000000000001',
    '',
  ])('rejects invalid/unsafe hourly rate %s', (rateMinor) => {
    const config = input();
    config.schedule[0].customer.rateMinor = rateMinor;
    expect(() => new DatedLabourCommercialResolver(config)).toThrow(
      /rate|range/,
    );
  });

  it('rejects cross-tenant, cross-worker and non-human entries', () => {
    const resolver = new DatedLabourCommercialResolver(input());
    for (const patch of [
      { tenantId: 'tenant-two' },
      { participantProfileId: 'worker-two' },
      { participantKind: 'agent' as const },
    ]) {
      const time = entry();
      Object.assign(time, patch);
      expect(() => resolver.validateEntry(time)).toThrow(/identity mismatch/);
    }
  });

  it('rejects ambiguous/unsafe hours and unsafe component and combined amounts', () => {
    const resolver = new DatedLabourCommercialResolver(input());
    for (const hours of ['0', '-1', '1e3', 'NaN', '9007199254740992'])
      expect(() => resolver.validateEntry(entry(hours))).toThrow();
    const time = entry();
    time.durationSeconds = 1;
    expect(() => resolver.validateEntry(time)).toThrow(/Ambiguous/);
    time.evidence = '[]';
    time.durationSeconds = Number.MAX_SAFE_INTEGER + 1;
    expect(() => resolver.validateEntry(time)).toThrow(/safe integer/);
    expect(() => resolver.validateEntry(entry('9007199254740990'))).toThrow(
      /safe integer/,
    );
    const config = input();
    config.schedule[0].wage.rateMinor = '9007199254740991';
    config.schedule[0].burden.rateMinor = '1';
    expect(() =>
      new DatedLabourCommercialResolver(config).validateEntry(entry('1')),
    ).toThrow(/Compensation total/);
  });
});

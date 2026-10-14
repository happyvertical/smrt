import { describe, expect, it } from 'vitest';
import {
  type ApprovedLabourValuationEvidence,
  DatedLabourCommercialResolver,
  type DatedPercentageLabourCommercialInput,
  DatedPercentageLabourCommercialResolver,
  type LabourValuationReconciliationInput,
  reconcileLabourValuation,
  ServiceTimeEntry,
} from '../index.js';

function config(): DatedPercentageLabourCommercialInput {
  return {
    tenantId: 'tenant',
    participantProfileId: 'worker',
    workDate: '2024-02-29',
    currency: 'CAD',
    billable: true,
    schedule: [
      {
        effectiveFrom: '2024-01-01',
        effectiveUntil: '2024-03-01',
        currency: 'CAD',
        customer: { id: 'customer', version: '1', rateMinor: '100' },
        wage: { id: 'wage', version: '1', rateMinor: '1' },
        burdenPercent: { id: 'burden', version: '1', percent: '100' },
      },
    ],
  };
}
function entry(hours = '0.25') {
  return Object.assign(new ServiceTimeEntry(), {
    tenantId: 'tenant',
    participantProfileId: 'worker',
    participantKind: 'human',
    durationSeconds: null,
    evidence: JSON.stringify([
      { kind: '@happyvertical/smrt-timesheets:duration-hours', hours },
    ]),
  });
}
async function evidence(
  id: string,
  terms = config(),
): Promise<ApprovedLabourValuationEvidence> {
  return {
    tenantId: terms.tenantId,
    participantProfileId: terms.participantProfileId,
    entryId: id,
    snapshotId: `snapshot-${id}`,
    groupId: 'project',
    groupVersion: '1',
    policy: { id: 'policy', version: '1', digest: 'retained-digest' },
    snapshot: {
      ...(await new DatedPercentageLabourCommercialResolver(
        terms,
      ).compensateProvider(
        Object.assign(entry(), {
          tenantId: terms.tenantId,
          participantProfileId: terms.participantProfileId,
        }),
      )),
      id: `snapshot-${id}`,
      tenantId: terms.tenantId,
      timeEntryId: id,
    },
  };
}
function reconciliation(
  rows: ApprovedLabourValuationEvidence[],
): LabourValuationReconciliationInput {
  return {
    tenantId: 'tenant',
    currency: 'CAD',
    groupId: 'project',
    groupVersion: '1',
    mode: 'half-up-exact-loaded-aggregate',
    evidence: rows,
  };
}

describe('percentage labour and private analytical reconciliation', () => {
  it('does not round the derived hourly burden before quarter-hour valuation', async () => {
    const terms = config();
    terms.schedule[0].wage.rateMinor = '3';
    terms.schedule[0].burdenPercent.percent = '50';
    const resolver = new DatedPercentageLabourCommercialResolver(terms);
    const snapshot = await resolver.compensateProvider(entry());
    expect(snapshot.amount).toBe(1);
    expect(snapshot.terms.burdenPercent).toEqual({
      id: 'burden',
      version: '1',
      percent: '50',
      amount: 0,
    });
    expect(snapshot.terms.loadedCostMinor).toBe(1);
    // Early hourly rounding 1.5 -> 2 would incorrectly produce burden 1.
    expect(snapshot.terms.burdenBasis).toEqual({
      wageId: 'wage',
      wageVersion: '1',
      hourlyNumerator: '150',
      hourlyDenominator: '100',
    });
    const client = await resolver.priceClient(entry());
    for (const field of [
      'wage',
      'burden',
      'burdenPercent',
      'burdenBasis',
      'loadedCostMinor',
    ])
      expect(client.terms).not.toHaveProperty(field);
  });

  it('retains a derived hourly product beyond 18 places, copying input and output terms', async () => {
    const terms = config();
    terms.schedule[0].wage.rateMinor = '0.000000000000000001';
    terms.schedule[0].burdenPercent.percent = '0.000000000000000001';
    const resolver = new DatedPercentageLabourCommercialResolver(terms);
    terms.schedule[0].burdenPercent.percent = '100';
    const paid = await resolver.compensateProvider(entry('1'));
    expect(paid.terms.burdenBasis).toMatchObject({
      hourlyNumerator: '1',
      hourlyDenominator: `1${'0'.repeat(38)}`,
    });
    (paid.terms.burdenPercent as Record<string, unknown>).percent = '999';
    expect(
      (await resolver.compensateProvider(entry('1'))).terms.burdenPercent,
    ).toMatchObject({ percent: '0.000000000000000001', amount: 0 });
  });

  it('does not round an extended-precision derived product across a final half boundary', async () => {
    const terms = config();
    terms.schedule[0].wage.rateMinor = '1.999999999999999999';
    terms.schedule[0].burdenPercent.percent = '25';
    const paid = await new DatedPercentageLabourCommercialResolver(
      terms,
    ).compensateProvider(entry('1'));
    expect(paid.terms.burdenPercent).toMatchObject({ amount: 0 });
    terms.schedule[0].wage.rateMinor = '2';
    expect(
      (
        await new DatedPercentageLabourCommercialResolver(
          terms,
        ).compensateProvider(entry('1'))
      ).terms.burdenPercent,
    ).toMatchObject({ amount: 1 });
  });

  it('allows independent tenant policies and rejects mixed-tenant analytical input', async () => {
    const other = config();
    other.tenantId = 'tenant-two';
    other.schedule[0].burdenPercent.percent = '200';
    const row = await evidence('other', other);
    row.policy = { id: 'second-policy', version: '2', digest: 'second-digest' };
    expect(
      reconcileLabourValuation({
        ...reconciliation([row]),
        tenantId: 'tenant-two',
      }),
    ).toMatchObject({ canonicalCostMinor: 1, analyticalCostMinor: 1 });
    expect(() => reconcileLabourValuation(reconciliation([row]))).toThrow(
      /mismatch/,
    );
  });

  it('accepts zero percent and rejects malformed or ambiguous inputs and overflow', async () => {
    const terms = config();
    terms.schedule[0].burdenPercent.percent = '0';
    expect(
      (
        await new DatedPercentageLabourCommercialResolver(
          terms,
        ).compensateProvider(entry('1'))
      ).terms.loadedCostMinor,
    ).toBe(1);
    for (const percent of [
      '-1',
      '1e2',
      '',
      '0.0000000000000000001',
      '9007199254740992',
    ]) {
      terms.schedule[0].burdenPercent.percent = percent;
      expect(
        () => new DatedPercentageLabourCommercialResolver(terms),
      ).toThrow();
    }
    terms.schedule[0].burdenPercent.percent = '100';
    terms.schedule[0].wage.rateMinor = '9007199254740991';
    expect(() =>
      new DatedPercentageLabourCommercialResolver(terms).validateEntry(
        entry('1'),
      ),
    ).toThrow(/Loaded/);
    Object.assign(terms.schedule[0], { burden: { rateMinor: '1' } });
    expect(() => new DatedPercentageLabourCommercialResolver(terms)).toThrow(
      /exclusive/,
    );
  });

  it('retains existing date and tenant/worker validation', async () => {
    const terms = config();
    const resolver = new DatedPercentageLabourCommercialResolver(terms);
    for (const patch of [
      { tenantId: 'foreign' },
      { participantProfileId: 'foreign' },
      { participantKind: 'agent' },
    ]) {
      expect(() =>
        resolver.validateEntry(Object.assign(entry(), patch)),
      ).toThrow(/identity/);
    }
    terms.workDate = '2024-03-01';
    expect(() => new DatedPercentageLabourCommercialResolver(terms)).toThrow(
      /No applicable/,
    );
    terms.schedule = [
      {
        ...terms.schedule[0],
        effectiveFrom: '2024-03-01',
        effectiveUntil: undefined,
      },
      ...terms.schedule,
    ];
    expect(
      (
        await new DatedPercentageLabourCommercialResolver(
          terms,
        ).compensateProvider(entry())
      ).terms.effectiveFrom,
    ).toBe('2024-03-01');
  });

  it('distinguishes canonical components from exact aggregate and is permutation deterministic', async () => {
    const rows = [await evidence('b'), await evidence('a')];
    const original = JSON.stringify(rows);
    const result = reconcileLabourValuation(reconciliation(rows));
    expect(result).toMatchObject({
      canonicalCostMinor: 0,
      analyticalCostMinor: 1,
      differenceMinor: 1,
    });
    expect(
      reconcileLabourValuation(reconciliation([...rows].reverse())),
    ).toEqual(result);
    expect(JSON.stringify(rows)).toBe(original);
    expect(
      reconcileLabourValuation(reconciliation([rows[0]])).canonicalCostMinor,
    ).toBe(0);
    expect(
      reconcileLabourValuation(reconciliation([rows[1]])).canonicalCostMinor,
    ).toBe(0);
  });

  it('supports retained additive snapshots and a negative analytical difference', async () => {
    const row = await evidence('a');
    const terms = config();
    const period = terms.schedule[0];
    const resolver = new DatedLabourCommercialResolver({
      ...terms,
      schedule: [
        {
          effectiveFrom: period.effectiveFrom,
          currency: period.currency,
          customer: period.customer,
          wage: { ...period.wage, rateMinor: '2' },
          burden: { id: 'burden', version: '1', rateMinor: '2' },
        },
      ],
    });
    row.snapshot = {
      ...row.snapshot,
      ...(await resolver.compensateProvider(entry())),
    };
    expect(reconcileLabourValuation(reconciliation([row]))).toMatchObject({
      canonicalCostMinor: 2,
      analyticalCostMinor: 1,
      differenceMinor: -1,
    });
  });

  it('preserves each historical policy version and checks aggregate overflow', async () => {
    const first = await evidence('a');
    const revised = config();
    revised.schedule[0].wage = { id: 'wage', version: '2', rateMinor: '4' };
    revised.schedule[0].burdenPercent = {
      id: 'burden',
      version: '2',
      percent: '50',
    };
    const second = await evidence('b', revised);
    second.policy = { id: 'policy', version: '2', digest: 'revision-two' };
    const result = reconcileLabourValuation(reconciliation([first, second]));
    expect(result).toMatchObject({
      canonicalCostMinor: 2,
      analyticalCostMinor: 2,
      differenceMinor: 0,
    });
    expect(result.evidence.map((item) => item.policy.version)).toEqual([
      '1',
      '2',
    ]);
    const maximum = config();
    maximum.schedule[0].wage.rateMinor = '9007199254740991';
    maximum.schedule[0].burdenPercent.percent = '0';
    const rows = await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) => evidence(id, maximum)),
    );
    expect(() => reconcileLabourValuation(reconciliation(rows))).toThrow(
      /aggregate/,
    );
  });

  it('uses exact measured seconds and rejects missing percentage policy and resource excess', async () => {
    const terms = config();
    terms.schedule[0].wage.rateMinor = '3600';
    terms.schedule[0].burdenPercent.percent = '50';
    const measured = Object.assign(entry(), {
      durationSeconds: 1,
      evidence: '[]',
    });
    const snapshot = await new DatedPercentageLabourCommercialResolver(
      terms,
    ).compensateProvider(measured);
    expect(snapshot.terms).toMatchObject({
      quantity: { seconds: 1 },
      loadedCostMinor: 2,
      burdenPercent: { amount: 1 },
    });
    terms.schedule[0].burdenPercent.percent = '0'.repeat(41);
    expect(() => new DatedPercentageLabourCommercialResolver(terms)).toThrow(
      /decimal/,
    );
    terms.schedule[0].burdenPercent = undefined as never;
    expect(() => new DatedPercentageLabourCommercialResolver(terms)).toThrow(
      /required/,
    );
    const row = await evidence('a');
    expect(() =>
      reconcileLabourValuation(reconciliation(Array(10001).fill(row))),
    ).toThrow(/between/);
  });

  it('rejects duplicate evidence, mismatched scope, inconsistent policy and altered snapshots', async () => {
    const row = await evidence('a');
    expect(() => reconcileLabourValuation(reconciliation([row, row]))).toThrow(
      /Duplicate/,
    );
    for (const patch of [
      { tenantId: 'other' },
      { groupId: 'other' },
      { groupVersion: 'other' },
      { snapshotId: 'other' },
      { entryId: 'other' },
    ]) {
      expect(() =>
        reconcileLabourValuation(reconciliation([{ ...row, ...patch }])),
      ).toThrow(/mismatch/);
    }
    const other = await evidence('b');
    other.policy.digest = 'changed';
    expect(() =>
      reconcileLabourValuation(reconciliation([row, other])),
    ).toThrow(/policy revision/);
    const driftConfig = config();
    driftConfig.schedule[0].wage.rateMinor = '2';
    const drifted = await evidence('drifted', driftConfig);
    expect(() =>
      reconcileLabourValuation(reconciliation([row, drifted])),
    ).toThrow(/rate revision/);
    const basisDrift = structuredClone(row);
    (
      basisDrift.snapshot.terms.burdenBasis as Record<string, unknown>
    ).wageVersion = 'changed';
    expect(() =>
      reconcileLabourValuation(reconciliation([basisDrift])),
    ).toThrow(/basis/);
    for (const patch of [
      { amount: -1 },
      { amount: 2 },
      { version: 'unknown' },
      { currency: 'USD' },
      { terms: {} },
    ]) {
      expect(() =>
        reconcileLabourValuation(
          reconciliation([{ ...row, snapshot: { ...row.snapshot, ...patch } }]),
        ),
      ).toThrow();
    }
    expect(() =>
      reconcileLabourValuation({
        ...reconciliation([row]),
        mode: undefined as never,
      }),
    ).toThrow(/mode/);
    expect(() => reconcileLabourValuation(reconciliation([]))).toThrow(
      /between/,
    );
  });
});

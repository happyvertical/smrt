import { describe, expect, it } from 'vitest';
import {
  allocateFrozenCredit,
  type FrozenCreditRequest,
  type FrozenCreditSourceLine,
  type IssuedCreditConsumption,
} from '../credit-allocation.js';
import { type MoneyValidationCode, MoneyValidationError } from '../money.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function source(
  overrides: Partial<FrozenCreditSourceLine> = {},
): FrozenCreditSourceLine {
  return {
    id: 'line-a',
    quantity: '1',
    netMinor: 100,
    discountMinor: 0,
    unitPrice: 100,
    discountType: 'none',
    discountRate: '0',
    ...overrides,
  };
}

function expectCode(run: () => unknown, code: MoneyValidationCode): void {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyValidationError);
    expect((error as MoneyValidationError).code).toBe(code);
  }
}

function seedRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function roundPositive(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

function byLine<T extends { creditedLineId: string }>(
  rows: readonly T[],
  id: string,
): T {
  const row = rows.find((candidate) => candidate.creditedLineId === id);
  if (!row) throw new Error(`Expected ${id}`);
  return row;
}

describe('frozen credit allocation (#3939)', () => {
  it('allocates deterministically and reconciles 10,000 seeded final remainders', () => {
    const random = seedRandom(0x3939_c0de);

    for (let caseNumber = 0; caseNumber < 10_000; caseNumber += 1) {
      const totalQuantity = 2 + (random() % 48);
      const unitPrice = 1 + (random() % 10_000);
      const gross = totalQuantity * unitPrice;
      const discount = random() % gross;
      const priorQuantity = random() % totalQuantity;
      const priorDiscount = roundPositive(
        discount * priorQuantity,
        totalQuantity,
      );
      const priorNet = priorQuantity * unitPrice - priorDiscount;
      const quantityId = `quantity-${caseNumber}`;
      const netId = `net-${caseNumber}`;
      const netTotal = 1 + (random() % 1_000_000);
      const priorNetOnly = random() % netTotal;
      const sources = [
        source({
          id: quantityId,
          quantity: String(totalQuantity),
          netMinor: gross - discount,
          discountMinor: discount,
          unitPrice,
          discountType: caseNumber % 2 === 0 ? 'amount' : 'percent',
          discountRate: caseNumber % 2 === 0 ? '0' : '10',
        }),
        source({
          id: netId,
          quantity: '1',
          netMinor: netTotal,
          unitPrice: netTotal,
        }),
      ];
      const issued: IssuedCreditConsumption[] = [
        {
          creditedLineId: quantityId,
          quantity: String(priorQuantity),
          netMinor: priorNet,
          discountMinor: priorDiscount,
        },
        {
          creditedLineId: netId,
          quantity: '0',
          netMinor: priorNetOnly,
          discountMinor: 0,
        },
      ];
      const requests: FrozenCreditRequest[] = [
        { creditedLineId: netId, netMinor: netTotal - priorNetOnly },
        {
          creditedLineId: quantityId,
          quantity: String(totalQuantity - priorQuantity),
        },
      ];

      const first = allocateFrozenCredit(sources, issued, requests);
      const second = allocateFrozenCredit(
        [...sources].reverse(),
        issued,
        [...requests].reverse(),
      );
      expect(second).toEqual(first);
      expect(first.allocations.map((row) => row.creditedLineId)).toEqual([
        netId,
        quantityId,
      ]);

      const quantity = byLine(first.allocations, quantityId);
      const net = byLine(first.allocations, netId);
      expect(quantity.basis).toMatchObject({
        kind: 'quantity',
        quantity: String(totalQuantity - priorQuantity),
        sourceQuantity: String(totalQuantity),
        sourceUnitPrice: unitPrice,
        sourceDiscountMinor: discount,
      });
      expect(quantity.exhaustsLine).toBe(true);
      expect(net).toMatchObject({
        netMinor: netTotal - priorNetOnly,
        discountMinor: 0,
        exhaustsLine: true,
      });

      const finalQuantity = totalQuantity - priorQuantity;
      const finalNet = finalQuantity * unitPrice - quantity.discountMinor;
      expect(priorQuantity + finalQuantity).toBe(totalQuantity);
      expect(priorDiscount + quantity.discountMinor).toBe(discount);
      expect(priorNet + finalNet).toBe(gross - discount);
      expect(priorNetOnly + (net.netMinor ?? 0)).toBe(netTotal);
      expect(first.exhaustsDocument).toBe(true);
    }
  });

  it('allocates a frozen percentage discount by cumulative quantity entitlement', () => {
    const line = source({
      quantity: '10',
      netMinor: 76_500,
      unitPrice: 8_500,
      discountMinor: 8_500,
      discountType: 'percent',
      discountRate: '10',
    });
    const first = allocateFrozenCredit(
      [line],
      [],
      [{ creditedLineId: line.id, quantity: '1' }],
    );
    expect(first.allocations).toMatchObject([
      { discountMinor: 850, exhaustsLine: false },
    ]);

    const middle = allocateFrozenCredit(
      [line],
      [
        {
          creditedLineId: line.id,
          quantity: '1',
          netMinor: 7_650,
          discountMinor: 850,
        },
      ],
      [{ creditedLineId: line.id, quantity: '8' }],
    );
    expect(middle.allocations).toMatchObject([
      { discountMinor: 6_800, exhaustsLine: false },
    ]);

    const final = allocateFrozenCredit(
      [line],
      [
        {
          creditedLineId: line.id,
          quantity: '9',
          netMinor: 68_850,
          discountMinor: 7_650,
        },
      ],
      [{ creditedLineId: line.id, quantity: '1' }],
    );
    expect(final).toMatchObject({
      allocations: [{ discountMinor: 850, exhaustsLine: true }],
      exhaustsDocument: true,
    });
    expectCode(
      () =>
        allocateFrozenCredit(
          [line],
          [
            {
              creditedLineId: line.id,
              quantity: '10',
              netMinor: 76_500,
              discountMinor: 8_500,
            },
          ],
          [{ creditedLineId: line.id, quantity: '1' }],
        ),
      'CREDIT_EXCEEDS_LINE',
    );
  });

  it('does not double an already front-loaded frozen discount', () => {
    const line = source({
      quantity: '7',
      netMinor: 66,
      unitPrice: 10,
      discountMinor: 4,
      discountType: 'percent',
      discountRate: '5.714286',
    });
    const frontLoaded = [
      {
        creditedLineId: line.id,
        quantity: '4',
        netMinor: 36,
        discountMinor: 4,
      },
    ];
    expect(
      allocateFrozenCredit([line], frontLoaded, [
        { creditedLineId: line.id, quantity: '1' },
      ]).allocations,
    ).toMatchObject([{ discountMinor: 0, exhaustsLine: false }]);
    expect(
      allocateFrozenCredit([line], frontLoaded, [
        { creditedLineId: line.id, quantity: '3' },
      ]),
    ).toMatchObject({
      allocations: [{ discountMinor: 0, exhaustsLine: true }],
      exhaustsDocument: true,
    });
  });

  it('conserves a positive sale and negative adjustment on a full credit', () => {
    const sale = source({ id: 'sale', netMinor: 100, unitPrice: 100 });
    const adjustment = source({
      id: 'adjustment',
      quantity: '3',
      netMinor: -35,
      unitPrice: -12,
      discountMinor: -1,
      discountType: 'amount',
    });
    const result = allocateFrozenCredit(
      [adjustment, sale],
      [],
      [
        { creditedLineId: 'sale', netMinor: 100 },
        { creditedLineId: 'adjustment', quantity: '3' },
      ],
    );
    const saleCredit = byLine(result.allocations, 'sale');
    const adjustmentCredit = byLine(result.allocations, 'adjustment');
    expect(saleCredit.netMinor).toBe(100);
    expect(adjustmentCredit).toMatchObject({
      discountMinor: -1,
      exhaustsLine: true,
    });
    const adjustmentNet = 3 * -12 - adjustmentCredit.discountMinor;
    expect(adjustmentNet).toBe(-35);
    expect((saleCredit.netMinor ?? 0) + adjustmentNet).toBe(65);
    expect((saleCredit.netMinor ?? 0) + adjustmentNet).toBeGreaterThanOrEqual(
      0,
    );
    expect(result.exhaustsDocument).toBe(true);
  });

  it('preserves signed partial adjustment quantities alongside positive lines', () => {
    const sale = source({ id: 'sale', netMinor: 100, unitPrice: 100 });
    const adjustment = source({
      id: 'adjustment',
      quantity: '4',
      netMinor: -36,
      unitPrice: -10,
      discountMinor: -4,
      discountType: 'percent',
      discountRate: '10',
    });
    const prior: IssuedCreditConsumption[] = [
      {
        creditedLineId: 'adjustment',
        quantity: '1',
        netMinor: -9,
        discountMinor: -1,
      },
    ];
    const result = allocateFrozenCredit([sale, adjustment], prior, [
      { creditedLineId: 'adjustment', quantity: '2' },
      { creditedLineId: 'sale', netMinor: 100 },
    ]);
    const saleCredit = byLine(result.allocations, 'sale');
    const adjustmentCredit = byLine(result.allocations, 'adjustment');
    expect(adjustmentCredit).toMatchObject({
      discountMinor: -2,
      exhaustsLine: false,
    });
    const adjustmentNet = 2 * -10 - adjustmentCredit.discountMinor;
    expect(adjustmentNet).toBe(-18);
    expect(-9 + adjustmentNet).toBe(-27);
    expect((saleCredit.netMinor ?? 0) - 9 + adjustmentNet).toBe(73);
    expect(
      (saleCredit.netMinor ?? 0) - 9 + adjustmentNet,
    ).toBeGreaterThanOrEqual(0);
    expect(result.exhaustsDocument).toBe(false);
  });

  it('uses half-away flat discounts and gives the last credit the exact residual', () => {
    const thirds = source({
      quantity: '3',
      netMinor: 29,
      unitPrice: 10,
      discountMinor: 1,
      discountType: 'amount',
    });
    const first = allocateFrozenCredit(
      [thirds],
      [],
      [{ creditedLineId: thirds.id, quantity: '1' }],
    );
    expect(first.allocations).toMatchObject([
      { discountMinor: 0, exhaustsLine: false },
    ]);

    const finalThird = allocateFrozenCredit(
      [thirds],
      [
        {
          creditedLineId: thirds.id,
          quantity: '2',
          netMinor: 20,
          discountMinor: 0,
        },
      ],
      [{ creditedLineId: thirds.id, quantity: '1' }],
    );
    expect(finalThird).toMatchObject({
      allocations: [{ discountMinor: 1, exhaustsLine: true }],
      exhaustsDocument: true,
    });

    const halves = source({
      id: 'line-halves',
      quantity: '2',
      netMinor: 19,
      unitPrice: 10,
      discountMinor: 1,
      discountType: 'amount',
    });
    const firstHalf = allocateFrozenCredit(
      [halves],
      [],
      [{ creditedLineId: halves.id, quantity: '1' }],
    );
    expect(firstHalf.allocations).toMatchObject([
      { discountMinor: 1, exhaustsLine: false },
    ]);
    const finalHalf = allocateFrozenCredit(
      [halves],
      [
        {
          creditedLineId: halves.id,
          quantity: '1',
          netMinor: 9,
          discountMinor: 1,
        },
      ],
      [{ creditedLineId: halves.id, quantity: '1' }],
    );
    expect(finalHalf.allocations).toMatchObject([
      { discountMinor: 0, exhaustsLine: true },
    ]);
  });

  it('caps quantity and net requests after targeted prior consumption', () => {
    const line = source({
      quantity: '5',
      netMinor: 100,
      unitPrice: 20,
      discountMinor: 10,
      discountType: 'amount',
    });
    const issued = [
      {
        creditedLineId: line.id,
        quantity: '2',
        netMinor: 36,
        discountMinor: 4,
      },
    ];
    expectCode(
      () =>
        allocateFrozenCredit([line], issued, [
          { creditedLineId: line.id, quantity: '4' },
        ]),
      'CREDIT_EXCEEDS_LINE',
    );
    expectCode(
      () =>
        allocateFrozenCredit([line], issued, [
          { creditedLineId: line.id, netMinor: 65 },
        ]),
      'CREDIT_EXCEEDS_LINE',
    );

    const targeted = allocateFrozenCredit(
      [
        source({ id: 'already-consumed', netMinor: 10, unitPrice: 10 }),
        source({ id: 'remaining', netMinor: 20, unitPrice: 20 }),
      ],
      [
        {
          creditedLineId: 'already-consumed',
          quantity: '0',
          netMinor: 10,
          discountMinor: 0,
        },
      ],
      [{ creditedLineId: 'remaining', netMinor: 20 }],
    );
    expect(targeted.exhaustsDocument).toBe(true);
  });

  it('carries the remaining net cap across mixed amount and quantity bases', () => {
    const line = source({
      quantity: '10',
      netMinor: 1_000,
      unitPrice: 100,
    });
    const allocation = allocateFrozenCredit(
      [line],
      [
        {
          creditedLineId: line.id,
          quantity: '0',
          netMinor: 900,
          discountMinor: 0,
        },
      ],
      [{ creditedLineId: line.id, quantity: '2' }],
    );
    expect(allocation.allocations).toMatchObject([
      {
        remainingNetMinor: 100,
        netMinor: null,
        exhaustsLine: false,
      },
    ]);
  });

  it('does not exhaust a multi-line document when only a subset is credited', () => {
    const allocation = allocateFrozenCredit(
      [
        source({ id: 'first', netMinor: 10, unitPrice: 10 }),
        source({ id: 'second', netMinor: 20, unitPrice: 20 }),
      ],
      [],
      [{ creditedLineId: 'first', netMinor: 10 }],
    );
    expect(allocation).toMatchObject({
      allocations: [{ creditedLineId: 'first', exhaustsLine: true }],
      exhaustsDocument: false,
    });
  });

  it('needs no issued consumption for goodwill credits that have no source line', () => {
    const result = allocateFrozenCredit(
      [source({ id: 'source', netMinor: 75, unitPrice: 75 })],
      [],
      [{ creditedLineId: 'source', netMinor: 75 }],
    );
    expect(result).toMatchObject({ exhaustsDocument: true });
    expect(result.allocations.map((row) => row.creditedLineId)).toEqual([
      'source',
    ]);
  });

  it('rejects duplicate sources or requests and malformed request values', () => {
    const line = source();
    expectCode(
      () =>
        allocateFrozenCredit(
          [line, { ...line }],
          [],
          [{ creditedLineId: line.id, netMinor: 1 }],
        ),
      'INVALID_MONEY_INPUT',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [line],
          [],
          [
            { creditedLineId: line.id, netMinor: 1 },
            { creditedLineId: line.id, quantity: '1' },
          ],
        ),
      'INVALID_MONEY_INPUT',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [line],
          [],
          [{ creditedLineId: line.id, quantity: '1.0000000' }],
        ),
      'INVALID_MONEY_INPUT',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [line],
          [],
          [{ creditedLineId: line.id, netMinor: MAX_SAFE + 1 }],
        ),
      'INVALID_MONEY_INPUT',
    );
  });

  it('rejects unsafe frozen money fields before allocating', () => {
    expectCode(
      () =>
        allocateFrozenCredit(
          [source({ netMinor: MAX_SAFE + 1 })],
          [],
          [{ creditedLineId: 'line-a', netMinor: 1 }],
        ),
      'UNSAFE_MONEY',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [
            source({
              quantity: '1',
              netMinor: 0,
              unitPrice: MAX_SAFE + 1,
            }),
          ],
          [],
          [{ creditedLineId: 'line-a', quantity: '1' }],
        ),
      'UNSAFE_MONEY',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [
            source({
              discountType: 'none',
              discountMinor: MAX_SAFE + 1,
            }),
          ],
          [],
          [{ creditedLineId: 'line-a', quantity: '1' }],
        ),
      'UNSAFE_MONEY',
    );
  });

  it('rejects malformed, unsafe, or untargeted prior consumption', () => {
    expectCode(
      () =>
        allocateFrozenCredit(
          [source()],
          [
            {
              creditedLineId: 'line-a',
              quantity: '0',
              netMinor: 1.5,
              discountMinor: 0,
            },
          ],
          [{ creditedLineId: 'line-a', quantity: '1' }],
        ),
      'UNSAFE_MONEY',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [source()],
          [
            {
              creditedLineId: 'line-a',
              quantity: '0',
              netMinor: MAX_SAFE + 1,
              discountMinor: 0,
            },
          ],
          [{ creditedLineId: 'line-a', quantity: '1' }],
        ),
      'UNSAFE_MONEY',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [source()],
          [
            {
              creditedLineId: 'line-a',
              quantity: '0',
              netMinor: 0,
              discountMinor: MAX_SAFE + 1,
            },
          ],
          [{ creditedLineId: 'line-a', quantity: '1' }],
        ),
      'UNSAFE_MONEY',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [source()],
          [
            {
              creditedLineId: 'goodwill-without-source',
              quantity: '1',
              netMinor: 1,
              discountMinor: 0,
            },
          ],
          [{ creditedLineId: 'line-a', quantity: '1' }],
        ),
      'INVALID_MONEY_INPUT',
    );
  });

  it('rejects malformed or unsafe frozen and issued values at its boundary', () => {
    expectCode(
      () =>
        allocateFrozenCredit(
          [source({ quantity: '1.0000000' })],
          [],
          [{ creditedLineId: 'line-a', quantity: '1' }],
        ),
      'INVALID_MONEY_INPUT',
    );
    expectCode(
      () =>
        allocateFrozenCredit(
          [source()],
          [
            {
              creditedLineId: 'line-a',
              quantity: 'not-a-quantity',
              netMinor: 0,
              discountMinor: 0,
            },
          ],
          [{ creditedLineId: 'line-a', quantity: '1' }],
        ),
      'INVALID_MONEY_INPUT',
    );
  });
});

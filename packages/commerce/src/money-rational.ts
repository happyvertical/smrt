/** Internal exact-rational primitives shared by commerce money calculators. */
export interface SignedRationalInput {
  id: string;
  numerator: bigint;
  denominator: bigint;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function roundSignedRational(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator <= 0n)
    throw new RangeError('Rational denominator must be positive');
  const magnitude = numerator < 0n ? -numerator : numerator;
  const result = (magnitude * 2n + denominator) / (denominator * 2n);
  return numerator < 0n ? -result : result;
}

function compareRemainders(
  left: SignedRationalInput,
  right: SignedRationalInput,
): number {
  const comparison =
    (left.numerator % left.denominator) * right.denominator -
    (right.numerator % right.denominator) * left.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

export function allocateSignedRationals(
  values: readonly SignedRationalInput[],
): { target: bigint; allocations: { id: string; value: bigint }[] } {
  let sumNumerator = 0n;
  let sumDenominator = 1n;
  const seen = new Set<string>();
  const allocations = values.map((value) => {
    if (typeof value.id !== 'string' || value.id.trim().length === 0)
      throw new TypeError('Rational IDs must be nonempty strings');
    if (seen.has(value.id)) throw new TypeError('Duplicate rational ID');
    seen.add(value.id);
    if (value.denominator <= 0n)
      throw new RangeError('Rational denominator must be positive');
    const divisor = greatestCommonDivisor(sumDenominator, value.denominator);
    const leftFactor = value.denominator / divisor;
    const rightFactor = sumDenominator / divisor;
    sumNumerator = sumNumerator * leftFactor + value.numerator * rightFactor;
    sumDenominator *= leftFactor;
    const reduction = greatestCommonDivisor(sumNumerator, sumDenominator);
    if (reduction > 1n) {
      sumNumerator /= reduction;
      sumDenominator /= reduction;
    }
    return { ...value, value: value.numerator / value.denominator };
  });
  const target = roundSignedRational(sumNumerator, sumDenominator);
  const truncated = allocations.reduce((sum, value) => sum + value.value, 0n);
  const residual = target - truncated;
  if (residual !== 0n) {
    const direction = residual > 0n ? 1n : -1n;
    const ranked = [...allocations].sort((left, right) => {
      const comparison = compareRemainders(left, right);
      if (comparison !== 0) return direction > 0n ? -comparison : comparison;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    const count = residual * direction;
    for (let index = 0; BigInt(index) < count; index++)
      ranked[index].value += direction;
  }
  return {
    target,
    allocations: allocations.map(({ id, value }) => ({ id, value })),
  };
}

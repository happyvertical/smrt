/** Sort state belongs to a rendered list, never to its data source. */
export interface ListSort {
  key: string;
  direction: 'ascending' | 'descending';
}

export function nextListSort(current: ListSort | null, key: string): ListSort {
  return {
    key,
    direction:
      current?.key === key && current.direction === 'ascending'
        ? 'descending'
        : 'ascending',
  };
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function missing(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (typeof value === 'number' && !Number.isFinite(value))
  );
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean')
    return Number(a) - Number(b);
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left === 'number' && typeof right === 'number')
    return left - right;
  return collator.compare(String(left), String(right));
}

/** Stable, non-mutating sort. Empty values remain last in both directions. */
export function sortListRows<T>(
  rows: readonly T[],
  sort: ListSort | null,
  readValue: (row: T, key: string) => unknown,
): T[] {
  if (!sort) return [...rows];
  return rows
    .map((row, index) => ({ row, index, value: readValue(row, sort.key) }))
    .sort((a, b) => {
      const aMissing = missing(a.value);
      const bMissing = missing(b.value);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      const order = aMissing ? 0 : compare(a.value, b.value);
      return (
        (sort.direction === 'ascending' ? order : -order) || a.index - b.index
      );
    })
    .map(({ row }) => row);
}

/** What checks report. A finding is data: nothing here throws or writes. */

export type FindingCode =
  | 'sheet-missing'
  | 'range-invalid'
  | 'header-outside-range'
  | 'column-outside-range'
  | 'coerce-failed'
  | 'required-blank'
  | 'digits-as-number'
  | 'lookup-key-not-unique'
  | 'lookup-key-blank'
  | 'reference-unresolved'
  | 'unmapped-column'
  | 'sum-unsafe'
  | 'row-count-mismatch'
  | 'sum-mismatch'
  | 'calculated-invalid'
  | 'calculated-mismatch';

export interface Finding {
  code: FindingCode;
  severity: 'error' | 'warning';
  table?: string;
  field?: string;
  sheet?: string;
  /** A1 address of the offending cell. */
  cell?: string;
  /** Absolute sheet row. */
  row?: number;
  /** 1-based sheet column, for findings about a whole column. */
  column?: number;
  expected?: string | number | boolean | null;
  actual?: string | number | boolean | null;
  /** Total findings of this code for this table and field, examples included. */
  count: number;
  message: string;
}

export type FindingInput = Omit<Finding, 'count'>;

/** At most this many examples are kept per (code, table, field). */
export const MAX_EXAMPLES = 20;

/** Collects findings, keeping a bounded number of examples and a total. */
export class FindingSink {
  private readonly groups = new Map<
    string,
    { total: number; items: FindingInput[] }
  >();

  add(finding: FindingInput): void {
    const key = `${finding.code}\u0000${finding.table ?? ''}\u0000${finding.field ?? ''}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { total: 0, items: [] };
      this.groups.set(key, group);
    }
    group.total++;
    if (group.items.length < MAX_EXAMPLES) group.items.push(finding);
  }

  /** Insertion order of first occurrence, then row order within a group. */
  list(): Finding[] {
    const out: Finding[] = [];
    for (const group of this.groups.values()) {
      for (const item of group.items) out.push({ ...item, count: group.total });
    }
    return out;
  }

  hasErrors(): boolean {
    for (const group of this.groups.values()) {
      if (group.items.some((item) => item.severity === 'error')) return true;
    }
    return false;
  }
}

export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

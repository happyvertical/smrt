/**
 * The record page header (#3718 record page), pure and Node-tested: the
 * heading, the monospace identifier, the status and two to four key facts,
 * all read by role from the fields the screen may show (so a field the
 * policy omits can never reach the header).
 *
 * - Heading: the `title` prop, else a document's kind and identifier
 *   ("Order GRA-3159", never the customer), else the title-role field, else
 *   the identifier, else the class name.
 * - Facts, in order: the party (a link), the lead date, the total money (the
 *   `total` role, else the first money field), then a contact (email, then
 *   phone) while there is room. Empty values are skipped.
 */
import {
  isLineAmountType,
  type LineAmountType,
} from '../overview/widgets/line-totals.js';
import { screenTitles } from './fields.js';
import { isDocumentLike, type ScreenFieldRoles } from './roles.js';
import type {
  ScreenCollectionDefinition,
  ScreenField,
  ScreenRecord,
} from './types.js';

export type RecordFactKind = 'party' | 'date' | 'money' | 'contact';

export interface RecordFact {
  kind: RecordFactKind;
  field: ScreenField;
}

export interface RecordHeaderModel {
  heading: string;
  /** The heading leads with the identifier (a document): render it monospace there. */
  headingIdentifier: boolean;
  identifier?: { field: ScreenField; value: string };
  status?: { field: ScreenField; value: string };
  facts: RecordFact[];
  /** Fields the header shows; the details card leaves them out. */
  shown: string[];
}

/** Most key facts in a header. */
export const RECORD_HEADER_MAX_FACTS = 4;

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function hasRole(field: ScreenField, role: string): boolean {
  return (field.roles ?? []).includes(role as never);
}

/**
 * The header of `record`: `fields` are the view fields
 * (`deriveScreenFields(..., { mode: 'view' })`), `roles` the definition's
 * (`deriveFieldRoles`).
 */
export function deriveRecordHeader(
  definition: ScreenCollectionDefinition,
  fields: readonly ScreenField[],
  record: ScreenRecord,
  roles: ScreenFieldRoles,
  options: { title?: string; maxFacts?: number } = {},
): RecordHeaderModel {
  const { singular } = screenTitles(definition);
  const filled = fields.filter((f) => present(record[f.name]));
  const find = (role: string) => filled.find((f) => hasRole(f, role));
  const shown: string[] = [];

  const titleField = find('title');
  const identifierField = find('identifier');
  const statusField = find('status');
  const identifierValue = identifierField
    ? String(record[identifierField.name])
    : undefined;

  let heading: string;
  let headingIdentifier = false;
  if (options.title) {
    heading = options.title;
  } else if (identifierValue && isDocumentLike(roles)) {
    heading = `${singular} ${identifierValue}`;
    headingIdentifier = true;
  } else if (titleField) {
    heading = String(record[titleField.name]);
  } else if (identifierValue) {
    heading = identifierValue;
    headingIdentifier = true;
  } else {
    heading = singular;
  }
  if (titleField && !headingIdentifier && !options.title)
    shown.push(titleField.name);

  const out: RecordHeaderModel = {
    heading,
    headingIdentifier,
    facts: [],
    shown,
  };
  if (identifierField && identifierValue) {
    out.identifier = { field: identifierField, value: identifierValue };
    shown.push(identifierField.name);
  }
  if (statusField) {
    out.status = {
      field: statusField,
      value: String(record[statusField.name]),
    };
    shown.push(statusField.name);
  }

  const max = options.maxFacts ?? RECORD_HEADER_MAX_FACTS;
  const add = (kind: RecordFactKind, field: ScreenField | undefined) => {
    if (!field || shown.includes(field.name) || out.facts.length >= max) return;
    out.facts.push({ kind, field });
    shown.push(field.name);
  };
  add('party', find('party'));
  add(
    'date',
    filled.find(
      (f) =>
        hasRole(f, 'date') && f.name !== 'createdAt' && f.name !== 'updatedAt',
    ),
  );
  add('money', find('total') ?? find('money'));
  add(
    'contact',
    filled.find((f) => f.kind === 'email'),
  );
  add(
    'contact',
    filled.find((f) => f.kind === 'tel'),
  );
  return out;
}

/**
 * The record's own totals, read by role (`subtotal`, `discount`, `tax`,
 * `total`): what the line-items totals block shows as authoritative, plus
 * the record's `lineAmountType` when it has a valid one, which tells the
 * block the discount is already in the lines (#4010). With `visible` (the
 * policy-filtered view fields), a field the policy omits is never read.
 */
export function recordTotals(
  record: ScreenRecord,
  roles: ScreenFieldRoles,
  visible?: readonly { name: string }[],
): {
  subtotal?: number | null;
  discount?: number | null;
  tax?: number | null;
  total?: number | null;
  lineAmountType?: LineAmountType;
} {
  const out: {
    subtotal?: number | null;
    discount?: number | null;
    tax?: number | null;
    total?: number | null;
    lineAmountType?: LineAmountType;
  } = {};
  for (const role of ['subtotal', 'discount', 'tax', 'total'] as const) {
    const field = Object.keys(roles).find(
      (name) =>
        roles[name]?.includes(role) &&
        (!visible || visible.some((f) => f.name === name)),
    );
    if (!field) continue;
    const value = record[field];
    out[role] =
      typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  }
  if (
    isLineAmountType(record.lineAmountType) &&
    (!visible || visible.some((f) => f.name === 'lineAmountType'))
  ) {
    out.lineAmountType = record.lineAmountType;
  }
  return out;
}

/** Fields holding a totals role (`subtotal` / `discount` / `tax` / `total`). */
export function totalsFields(roles: ScreenFieldRoles): string[] {
  return Object.keys(roles).filter((name) =>
    (['subtotal', 'discount', 'tax', 'total'] as const).some((role) =>
      roles[name]?.includes(role),
    ),
  );
}

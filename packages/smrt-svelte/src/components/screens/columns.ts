/**
 * Table columns chosen by role (#3718 record page): the columns a related
 * records table shows for a child model, and the columns of a line-items
 * table. Pure and Node-tested; `deriveScreenRelations` attaches them to each
 * `children` / `items` relation, and `widgets/record-table.ts` re-exports
 * them for hosts that build their own.
 */
import type { RecordListColumn } from '../overview/widgets/data.js';
import { humanizeFieldName } from './fields.js';
import type { FieldRole, ScreenFieldRoles } from './roles.js';
import type { ScreenCollectionDefinition } from './types.js';

/** Roles that render one column each, in table order. */
const COLUMN_ROLE_ORDER: readonly FieldRole[] = [
  'identifier',
  'status',
  'date',
  'party',
  'total',
  'money',
];

/** A records column's role: the first of its roles a table renders specially. */
function renderRole(roles: readonly FieldRole[]): FieldRole | undefined {
  for (const role of [
    'identifier',
    'status',
    'date',
    'money',
    'quantity',
    'party',
    'title',
  ] as const) {
    if (roles.includes(role)) return role;
  }
  return undefined;
}

/**
 * Columns a related-records table shows for a child model, chosen by role:
 * identifier (else the title), status, the lead date, a party other than the
 * parent link, and the amount (the record's total, else its first money
 * field). `exclude` drops the FK back to the parent.
 */
export function relatedColumns(
  definition: ScreenCollectionDefinition,
  roles: ScreenFieldRoles,
  options: { exclude?: readonly string[]; max?: number } = {},
): RecordListColumn[] {
  const exclude = new Set(options.exclude ?? []);
  const max = options.max ?? 4;
  const names = Object.keys(roles).filter(
    (name) => !exclude.has(name) && name in definition.fields,
  );
  const pick = (role: FieldRole): string | undefined =>
    names.find((name) => roles[name]?.includes(role));
  const chosen: string[] = [];
  const add = (name: string | undefined) => {
    if (name && !chosen.includes(name)) chosen.push(name);
  };
  add(pick('identifier') ?? pick('title'));
  for (const role of COLUMN_ROLE_ORDER) {
    if (role === 'identifier') continue;
    if (role === 'money' && chosen.some((n) => roles[n]?.includes('money')))
      continue;
    if (role === 'date') {
      // The lead date: a business date before the system timestamps.
      add(
        names.find(
          (n) =>
            roles[n]?.includes('date') &&
            n !== 'createdAt' &&
            n !== 'updatedAt',
        ) ?? pick('date'),
      );
      continue;
    }
    add(pick(role));
  }
  return chosen.slice(0, max).map((name) => ({
    key: name,
    label: humanizeColumnLabel(name, definition),
    ...(renderRole(roles[name] ?? [])
      ? { role: renderRole(roles[name] ?? []) }
      : {}),
  }));
}

/**
 * Columns of a line-items table: the item (description / title / name),
 * quantity, unit price and the line amount. `unitPrice` is the money field
 * named like a unit price; the amount is the last other money field.
 */
export function lineItemColumns(
  definition: ScreenCollectionDefinition,
  roles: ScreenFieldRoles,
  options: { exclude?: readonly string[] } = {},
): RecordListColumn[] {
  const exclude = new Set(options.exclude ?? []);
  const names = Object.keys(roles).filter(
    (name) => !exclude.has(name) && name in definition.fields,
  );
  const textNames = names.filter((n) => definition.fields[n]?.type === 'text');
  const item =
    textNames.find((n) => /^(?:description|title|name|label)$/.test(n)) ??
    textNames.find((n) => roles[n]?.includes('title')) ??
    textNames.find((n) => !roles[n]?.includes('identifier'));
  const quantity = names.find((n) => roles[n]?.includes('quantity'));
  const money = names.filter((n) => roles[n]?.includes('money'));
  const unit = money.find((n) => /unit|price|rate/i.test(n));
  const amount =
    money.find((n) => /^(?:amount|lineTotal|total|lineAmount)$/.test(n)) ??
    [...money].reverse().find((n) => n !== unit);
  const out: RecordListColumn[] = [];
  if (item)
    out.push({ key: item, label: humanizeColumnLabel(item, definition) });
  if (quantity)
    out.push({
      key: quantity,
      label: humanizeColumnLabel(quantity, definition),
      role: 'quantity',
    });
  if (unit)
    out.push({
      key: unit,
      label: humanizeColumnLabel(unit, definition),
      role: 'money',
    });
  if (amount && amount !== unit)
    out.push({
      key: amount,
      label: humanizeColumnLabel(amount, definition),
      role: 'money',
    });
  return out;
}

function humanizeColumnLabel(
  name: string,
  definition: ScreenCollectionDefinition,
): string {
  const field = definition.fields[name];
  if (
    field &&
    (field.type === 'foreignKey' || field.type === 'crossPackageRef') &&
    /.[a-z]Id$/.test(name)
  ) {
    return humanizeFieldName(name.slice(0, -2));
  }
  return humanizeFieldName(name);
}

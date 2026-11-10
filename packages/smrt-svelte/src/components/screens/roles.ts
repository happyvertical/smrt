/**
 * Field roles (#3718 record page): what a field MEANS on a record page, as
 * opposed to how it is stored. A record header reads its title, identifier,
 * status and key facts by role; related tables pick their columns by role;
 * line items and the totals block read quantity, money and the
 * subtotal / tax / discount / total roles.
 *
 * Pure and Node-tested. Sources, in order:
 *
 * 1. Explicit metadata on the field definition: `role`, `format`, `enum`,
 *    `display`. An explicit `role` is authoritative: name heuristics never
 *    add to it (a `format` / `display` still does).
 * 2. Manifest `ui` hints: `ui.format` (`money` / `date` / `datetime`), and
 *    `ui.widget: 'currency'` on an INTEGER field (the legacy money hint; on a
 *    text field it names the currency CODE, which is not money).
 * 3. Name heuristics, only for fields with no explicit `role`.
 *
 * Money is integer minor units only (the cross-package invariant), so the
 * name heuristics never mark a decimal as money; an explicit `role` or
 * `format` on a decimal is honoured as declared.
 */
import type {
  ScreenCollectionDefinition,
  ScreenFieldDefinition,
  ScreenRelationshipDefinition,
} from './types.js';

/** What a field means on a record page. One field may hold several roles. */
export type FieldRole =
  | 'title'
  | 'identifier'
  | 'status'
  | 'money'
  | 'quantity'
  | 'date'
  | 'party'
  | 'subtotal'
  | 'tax'
  | 'discount'
  | 'total';

/** Every role, in the order a role list is reported. */
export const FIELD_ROLES: readonly FieldRole[] = [
  'title',
  'identifier',
  'status',
  'money',
  'quantity',
  'date',
  'party',
  'subtotal',
  'tax',
  'discount',
  'total',
];

/** Roles of every declared field of a definition, keyed by field name. */
export type ScreenFieldRoles = Readonly<Record<string, readonly FieldRole[]>>;

const NUMERIC = new Set(['integer', 'decimal']);
const REFERENCE = new Set(['foreignKey', 'crossPackageRef']);

/** `*Amount`, `*Total`, `price`, `cost` (and the totals roles' own names). */
const MONEY_NAME =
  /(?:^|[a-z])(?:amount|total|price|cost)$|^(?:subtotal|tax|discount)$/i;
const SUBTOTAL_NAME = /^subtotal(?:Amount)?$|[a-z]Subtotal(?:Amount)?$/;
const TAX_NAME = /^tax(?:Amount|Total)?$|[a-z]Tax(?:Amount|Total)?$/;
const DISCOUNT_NAME =
  /^discount(?:Amount|Total)?$|[a-z]Discount(?:Amount|Total)?$/;
const TOTAL_NAME = /^(?:total|grandTotal)(?:Amount)?$|^amountTotal$/;
const RATE_NAME = /(?:rate|percent|percentage|pct|ratio)$/i;
const STATUS_NAME = /^(?:status|state)$|[a-z](?:Status|State)$/;
const IDENTIFIER_NAME =
  /^(?:number|reference|code|ref)$|[a-z](?:Number|Reference|Code)$/;
/** `phoneNumber`, `postalCode`, `currencyCode`, ... are not the record's identifier. */
const NOT_IDENTIFIER =
  /^(?:phone|mobile|fax|postal|zip|country|currency|language|locale|tax|vat|account|routing|card|area|promo|coupon|discount|sort|tracking|billing|shipping|iban|swift|bank|unit|line|street|house|building)/i;
const DATE_NAME = /^date$|[a-z](?:At|Date|On|Until)$/;
const QUANTITY_NAME = /^(?:quantity|qty)|(?:Quantity|Qty)$/;
const TITLE_NAMES = ['name', 'title', 'label', 'displayName'] as const;
/** A party: who a record is with. Matched against the FK name and its target. */
const PARTY_NAME =
  /customer|vendor|supplier|client|party|profile|contact|person|people|member|company|organi[sz]ation|payer|payee|buyer|seller|licensee|lessee/i;

function explicitRoles(definition: ScreenFieldDefinition): FieldRole[] | null {
  const role = definition.role;
  if (role === undefined) return null;
  const list = (Array.isArray(role) ? role : [role]) as readonly unknown[];
  return list.filter((r): r is FieldRole =>
    (FIELD_ROLES as readonly unknown[]).includes(r),
  );
}

function formatOf(
  definition: ScreenFieldDefinition,
): ScreenFieldDefinition['format'] {
  return definition.format ?? definition.ui?.format;
}

/** True when a field declares money through metadata or a manifest hint. */
function hintedMoney(definition: ScreenFieldDefinition): boolean {
  if (formatOf(definition) === 'money') return true;
  return definition.type === 'integer' && definition.ui?.widget === 'currency';
}

function hasEnum(definition: ScreenFieldDefinition): boolean {
  return Array.isArray(definition.enum) && definition.enum.length > 0;
}

function relationshipFor(
  relationships: readonly ScreenRelationshipDefinition[] | undefined,
  field: string,
): ScreenRelationshipDefinition | undefined {
  return relationships?.find((edge) => edge.field === field);
}

function heuristicRoles(
  name: string,
  definition: ScreenFieldDefinition,
  relationship: ScreenRelationshipDefinition | undefined,
): FieldRole[] {
  const roles: FieldRole[] = [];
  const { type } = definition;
  const numeric = NUMERIC.has(type);
  const rate = RATE_NAME.test(name);

  if (type === 'text') {
    if (hasEnum(definition) && STATUS_NAME.test(name)) roles.push('status');
    if (
      IDENTIFIER_NAME.test(name) &&
      !NOT_IDENTIFIER.test(name) &&
      definition.ui?.widget !== 'phone'
    ) {
      roles.push('identifier');
    }
  }
  if (type === 'integer' && !rate && MONEY_NAME.test(name)) roles.push('money');
  if (numeric && QUANTITY_NAME.test(name)) roles.push('quantity');
  if (type === 'datetime' && DATE_NAME.test(name)) roles.push('date');
  if (REFERENCE.has(type)) {
    const target = relationship?.relatedCollection ?? '';
    const base = name.replace(/Id$/, '');
    if (base !== 'tenant' && (PARTY_NAME.test(base) || PARTY_NAME.test(target)))
      roles.push('party');
  }
  if (numeric && !rate) {
    if (SUBTOTAL_NAME.test(name)) roles.push('subtotal');
    else if (TAX_NAME.test(name)) roles.push('tax');
    else if (DISCOUNT_NAME.test(name)) roles.push('discount');
    else if (TOTAL_NAME.test(name)) roles.push('total');
  }
  return roles;
}

function ordered(roles: Iterable<FieldRole>): FieldRole[] {
  const set = new Set(roles);
  return FIELD_ROLES.filter((r) => set.has(r));
}

/**
 * Roles of every declared field of `definition` (a key per field, possibly
 * an empty list). Without an explicit `display` field, the first text field
 * named `name` / `title` / `label` / `displayName` takes the `title` role.
 */
export function deriveFieldRoles(
  definition: ScreenCollectionDefinition,
): Record<string, FieldRole[]> {
  const out: Record<string, FieldRole[]> = {};
  const entries = Object.entries(definition.fields).filter(
    ([name]) => !name.startsWith('_') && !name.startsWith('$'),
  );
  const hasDisplay = entries.some(([, d]) => d.display === true);
  for (const [name, fieldDefinition] of entries) {
    const roles = new Set<FieldRole>();
    const explicit = explicitRoles(fieldDefinition);
    if (explicit) for (const r of explicit) roles.add(r);
    else {
      for (const r of heuristicRoles(
        name,
        fieldDefinition,
        relationshipFor(definition.relationships, name),
      ))
        roles.add(r);
    }
    if (hintedMoney(fieldDefinition)) roles.add('money');
    const format = formatOf(fieldDefinition);
    if (
      (format === 'date' || format === 'datetime') &&
      fieldDefinition.type === 'datetime'
    ) {
      roles.add('date');
    }
    if (fieldDefinition.display === true) roles.add('title');
    out[name] = ordered(roles);
  }
  if (!hasDisplay && !Object.values(out).some((r) => r.includes('title'))) {
    for (const candidate of TITLE_NAMES) {
      const fieldDefinition = definition.fields[candidate];
      if (
        fieldDefinition?.type === 'text' &&
        explicitRoles(fieldDefinition) === null
      ) {
        out[candidate] = ordered([...(out[candidate] ?? []), 'title']);
        break;
      }
    }
  }
  return out;
}

/** Fields holding `role`, in declaration order. */
export function fieldsWithRole(
  roles: ScreenFieldRoles,
  role: FieldRole,
): string[] {
  return Object.keys(roles).filter((name) => roles[name]?.includes(role));
}

/** The first field holding `role`, or `undefined`. */
export function fieldWithRole(
  roles: ScreenFieldRoles,
  role: FieldRole,
): string | undefined {
  return Object.keys(roles).find((name) => roles[name]?.includes(role));
}

/**
 * The field naming a record's currency: a text field hinted
 * `ui.widget: 'currency'` (the manifest's currency-code picker), else a text
 * field named `currency` / `currencyCode`.
 */
export function currencyCodeField(
  definition: ScreenCollectionDefinition,
): string | undefined {
  const entries = Object.entries(definition.fields);
  return (
    entries.find(
      ([, d]) => d.type === 'text' && d.ui?.widget === 'currency',
    )?.[0] ??
    entries.find(
      ([name, d]) => d.type === 'text' && /^currency(?:Code)?$/.test(name),
    )?.[0]
  );
}

/**
 * Whether records of this definition read like documents (an order, an
 * invoice): an identifier plus a party or a total. Their header leads with
 * the identifier ("Order GRA-3159") rather than a name.
 */
export function isDocumentLike(roles: ScreenFieldRoles): boolean {
  return (
    fieldWithRole(roles, 'identifier') !== undefined &&
    (fieldWithRole(roles, 'party') !== undefined ||
      fieldWithRole(roles, 'total') !== undefined)
  );
}

/**
 * Whether a child definition has line-item roles: a quantity and a money
 * field (`deriveScreenRelations` classifies such a child relation `items`).
 */
export function hasLineItemRoles(roles: ScreenFieldRoles): boolean {
  return (
    fieldWithRole(roles, 'quantity') !== undefined &&
    fieldWithRole(roles, 'money') !== undefined
  );
}

/**
 * Contact rows for customers and vendors (#3501).
 *
 * `CustomerForm` and `VendorForm` (`./svelte`) post contacts as repeated
 * field names in DOM order, one value per row for each of `contactId`,
 * `contactName`, `contactLabel`, `contactEmail`, `contactPhone`, and
 * `contactAddress` (all overridable through the forms' `fieldNames`). The
 * helpers here read that payload, apply the native add/remove intents, and
 * write the rows to `Customer.contacts` / `Vendor.contacts`.
 *
 * @packageDocumentation
 */

import type { CustomerCollection } from './collections/CustomerCollection.js';
import type { VendorCollection } from './collections/VendorCollection.js';
import type { Customer } from './models/Customer.js';
import type { Vendor } from './models/Vendor.js';
import type { PartyContact } from './types/index.js';

/** One submitted contact row, exactly as posted (untrimmed strings). */
export type PartyContactInput = Partial<PartyContact>;

/** The text fields of a contact, which are also its error keys. */
export type PartyContactField = Exclude<keyof PartyContact, 'id'>;

/** HTML names of the repeated contact fields; defaults match the forms. */
export interface PartyContactFieldNames {
  contactId: string;
  contactName: string;
  contactLabel: string;
  contactEmail: string;
  contactPhone: string;
  contactAddress: string;
  /** Hidden presence marker: the number of contact rows the form rendered. */
  contactCount: string;
}

/** Default contact field names, matching `DEFAULT_PARTY_FIELD_NAMES` in `./svelte`. */
export const DEFAULT_PARTY_CONTACT_FIELD_NAMES: PartyContactFieldNames = {
  contactId: 'contactId',
  contactName: 'contactName',
  contactLabel: 'contactLabel',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  contactAddress: 'contactAddress',
  contactCount: 'contactCount',
};

/** Maximum lengths, matching the form controls' `maxlength`. */
export const PARTY_CONTACT_MAX_LENGTHS: Readonly<
  Record<PartyContactField, number>
> = {
  name: 160,
  label: 80,
  email: 320,
  phone: 80,
  address: 500,
};

/**
 * Per-row validation error codes, keyed by field. `unknown_contact` (on
 * `id`) means the posted id is not one of the party's saved contacts — a
 * stale or altered form; reload the party and show its current rows.
 */
export type PartyContactErrorCode =
  | 'too_long'
  | 'invalid_email'
  | 'unknown_contact';

/** Errors for one submitted row; indexes match the submitted rows. */
export type PartyContactRowErrors = Partial<
  Record<PartyContactField | 'id', PartyContactErrorCode>
>;

const FIELDS: readonly PartyContactField[] = [
  'name',
  'label',
  'email',
  'phone',
  'address',
];

/** Thrown by {@link savePartyContacts} when any row is invalid; nothing is written. */
export class PartyContactValidationError extends Error {
  /** Errors aligned with the submitted rows; `undefined` for a valid row. */
  readonly errors: Array<PartyContactRowErrors | undefined>;

  constructor(errors: Array<PartyContactRowErrors | undefined>) {
    super('One or more contact rows are invalid');
    this.name = 'PartyContactValidationError';
    this.errors = errors;
  }
}

/**
 * Thrown by {@link readPartyContactRows} (and so {@link savePartyContacts}
 * given a form) when the posted contact payload cannot be trusted:
 * `missing` — no `contactCount` marker, so the editable contact block did
 * not render or was posted under other field names (treating that as "no
 * contacts" would delete them all); `misaligned` — the repeated fields or
 * the marker disagree on the row count. Nothing is written.
 */
export class PartyContactPayloadError extends Error {
  readonly reason: 'missing' | 'misaligned';

  constructor(reason: 'missing' | 'misaligned', message: string) {
    super(message);
    this.name = 'PartyContactPayloadError';
    this.reason = reason;
  }
}

/** Thrown by {@link savePartyContacts} when the party is not visible in the current tenant. */
export class PartyContactPartyNotFoundError extends Error {
  constructor(partyId: string) {
    super(`Customer or vendor ${partyId} was not found`);
    this.name = 'PartyContactPartyNotFoundError';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Normalize stored contacts (an array, a JSON string, or nothing) into
 * well-formed {@link PartyContact} rows. Non-object entries and non-string
 * values are dropped; a row without an id is given one.
 */
export function normalizePartyContacts(value: unknown): PartyContact[] {
  let input = value;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(input)) return [];
  const contacts: PartyContact[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    contacts.push({
      id: text(row.id) || globalThis.crypto.randomUUID(),
      name: text(row.name),
      label: text(row.label),
      email: text(row.email),
      phone: text(row.phone),
      address: text(row.address),
    });
  }
  return contacts;
}

/** Minimal form-data reader; `FormData` and `URLSearchParams` both satisfy it. */
export interface PartyContactFormSource {
  getAll(name: string): unknown[];
}

/**
 * Read the contact rows a party form posted, in DOM order. The editable
 * contact block always posts a `contactCount` marker with its row count, and
 * every row renders all six fields. A missing marker (the block did not
 * render, or `fieldNames` differ from the form's) or any disagreeing count
 * throws {@link PartyContactPayloadError}, so zero rows is only ever read
 * when the form really posted an empty contact list.
 */
export function readPartyContactRows(
  form: PartyContactFormSource,
  fieldNames: Partial<PartyContactFieldNames> = {},
): PartyContactInput[] {
  const names = { ...DEFAULT_PARTY_CONTACT_FIELD_NAMES, ...fieldNames };
  const column = (name: string) => form.getAll(name).map(text);
  const columns = {
    id: column(names.contactId),
    name: column(names.contactName),
    label: column(names.contactLabel),
    email: column(names.contactEmail),
    phone: column(names.contactPhone),
    address: column(names.contactAddress),
  };
  const markers = column(names.contactCount);
  if (markers.length !== 1)
    throw new PartyContactPayloadError(
      markers.length === 0 ? 'missing' : 'misaligned',
      markers.length === 0
        ? `Contact payload has no ${names.contactCount} marker; the contact fields were not posted under these names`
        : `Contact payload has ${markers.length} ${names.contactCount} markers`,
    );
  const count = columns.id.length;
  if (markers[0] !== String(count))
    throw new PartyContactPayloadError(
      'misaligned',
      `Contact payload is misaligned: ${names.contactCount} is ${markers[0]} but ${count} contact ids were posted`,
    );
  for (const [key, values] of Object.entries(columns)) {
    if (values.length !== count)
      throw new PartyContactPayloadError(
        'misaligned',
        `Contact payload is misaligned: ${count} contact ids but ${values.length} ${key} values`,
      );
  }
  return columns.id.map((id, index) => ({
    id,
    name: columns.name[index],
    label: columns.label[index],
    email: columns.email[index],
    phone: columns.phone[index],
    address: columns.address[index],
  }));
}

/** Submitter values for the forms' native contact row actions. */
export interface PartyContactIntents {
  /** Defaults to the forms' `addContact`. */
  addIntent?: string;
  /** Parses a remove submitter into a row index; defaults to `removeContact:<index>`. */
  parseRemoveIntent?: (intent: string) => number | undefined;
}

function defaultParseRemoveIntent(intent: string): number | undefined {
  const match = /^removeContact:(\d+)$/.exec(intent);
  return match ? Number(match[1]) : undefined;
}

/**
 * Apply an add or remove submitter to the posted rows and return the rows
 * to render back into the form. Nothing is persisted: a row action is a
 * round trip, and only the save intent writes. `handled` is `false` for any
 * other intent (including save), with the rows unchanged; when it is `true`,
 * render the returned rows and do not save.
 */
export function applyPartyContactIntent(
  rows: readonly PartyContactInput[],
  intent: string,
  intents: PartyContactIntents = {},
): { contacts: PartyContactInput[]; handled: boolean } {
  if (intent === (intents.addIntent ?? 'addContact'))
    return { contacts: [...rows, {}], handled: true };
  const index = (intents.parseRemoveIntent ?? defaultParseRemoveIntent)(intent);
  // A stale index (the row is already gone) is still a remove: it must not
  // fall through to a save.
  if (index !== undefined)
    return {
      contacts: rows.filter((_, position) => position !== index),
      handled: true,
    };
  return { contacts: [...rows], handled: false };
}

// Deliberately permissive: one "@" with text on both sides and no spaces.
// Deliverability is the caller's concern.
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * Validate posted rows without persisting them. Returns the trimmed rows
 * that would be written (blank rows dropped) and, when any row is invalid,
 * errors aligned with the submitted rows. Ids are checked against the
 * party's saved contacts only by {@link savePartyContacts}.
 */
export function validatePartyContactRows(rows: readonly PartyContactInput[]): {
  contacts: PartyContactInput[];
  errors?: Array<PartyContactRowErrors | undefined>;
} {
  const contacts: PartyContactInput[] = [];
  const errors: Array<PartyContactRowErrors | undefined> = [];
  let invalid = false;
  rows.forEach((row, index) => {
    const trimmed: PartyContactInput = { id: text(row.id).trim() };
    let rowErrors: PartyContactRowErrors | undefined;
    for (const field of FIELDS) {
      const value = text(row[field]).trim();
      trimmed[field] = value;
      if (value.length > PARTY_CONTACT_MAX_LENGTHS[field])
        rowErrors = { ...rowErrors, [field]: 'too_long' };
    }
    if (trimmed.email && !rowErrors?.email && !EMAIL.test(trimmed.email))
      rowErrors = { ...rowErrors, email: 'invalid_email' };
    errors[index] = rowErrors;
    if (rowErrors) invalid = true;
    if (FIELDS.some((field) => trimmed[field])) contacts.push(trimmed);
  });
  return invalid ? { contacts, errors } : { contacts };
}

/** Options for {@link savePartyContacts}. */
export interface SavePartyContactsOptions {
  /** Field names used to read a posted form; must match the form's `fieldNames`. */
  fieldNames?: Partial<PartyContactFieldNames>;
  /**
   * When set, the party must belong to this tenant. Use it to bind a form's
   * posted tenant to the loaded row in addition to the active tenant
   * context, which already scopes the lookup.
   */
  expectedTenantId?: string | null;
}

/**
 * Replace a customer's or vendor's contacts with the rows its form posted.
 *
 * Pass the posted `FormData` (with `options.fieldNames` when the form
 * overrides them): it is read with {@link readPartyContactRows}, so a payload
 * without the contact block's presence marker throws
 * {@link PartyContactPayloadError} instead of removing every contact. An
 * array is taken as rows the caller already read through that function.
 *
 * The party is loaded through `collection.get()`, so the active tenant
 * context scopes it: a party in another tenant is not found. Rows are
 * validated ({@link validatePartyContactRows}), blank rows dropped, kept
 * rows matched to saved contacts by id (new rows get a fresh id), and rows
 * that were not posted are removed. A posted id the party does not have is
 * an `unknown_contact` error. On any error nothing is written and a
 * {@link PartyContactValidationError} is thrown.
 *
 * This is a read-modify-write of one row: concurrent saves of the same party
 * are last-writer-wins, like any other field edit.
 *
 * @returns The saved contacts, in submitted order.
 */
export async function savePartyContacts(
  collection: CustomerCollection | VendorCollection,
  partyId: string,
  posted: PartyContactFormSource | readonly PartyContactInput[],
  options: SavePartyContactsOptions = {},
): Promise<PartyContact[]> {
  // Reading the form here (rather than trusting a caller's array) keeps the
  // presence-marker check on the write path.
  const rows = Array.isArray(posted)
    ? (posted as readonly PartyContactInput[])
    : readPartyContactRows(
        posted as PartyContactFormSource,
        options.fieldNames,
      );
  const party: Customer | Vendor | null = await collection.get({
    id: partyId,
  });
  if (
    !party ||
    (options.expectedTenantId !== undefined &&
      party.tenantId !== options.expectedTenantId)
  )
    throw new PartyContactPartyNotFoundError(partyId);

  const validation = validatePartyContactRows(rows);
  const { contacts } = validation;
  const errors = validation.errors ?? rows.map(() => undefined);
  const saved = new Set(
    normalizePartyContacts(party.contacts).map((c) => c.id),
  );
  let invalid = validation.errors !== undefined;
  rows.forEach((row, index) => {
    const id = text(row.id).trim();
    if (id && !saved.has(id)) {
      errors[index] = { ...errors[index], id: 'unknown_contact' };
      invalid = true;
    }
  });
  if (invalid) throw new PartyContactValidationError(errors);

  const seen = new Set<string>();
  party.contacts = contacts.map((row) => {
    // A duplicated posted id (two rows claiming one contact) keeps the id
    // on the first row only, so stored ids stay unique.
    const id =
      row.id && !seen.has(row.id) ? row.id : globalThis.crypto.randomUUID();
    seen.add(id);
    return {
      id,
      name: row.name ?? '',
      label: row.label ?? '',
      email: row.email ?? '',
      phone: row.phone ?? '',
      address: row.address ?? '',
    };
  });
  await party.save();
  return party.contacts;
}

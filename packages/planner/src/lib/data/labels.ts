/**
 * Labels for related records, and the searches the relation selectors run.
 * Everything goes through the `DataSource`, so live collections replace the
 * fakes without touching a view.
 *
 * A record is labelled by its own `display.label` field (the first of `name`,
 * `title`, `label`, `code` when undeclared; see `display.ts`). A
 * Customer or Vendor has none: its name lives on its Profile, so it is joined
 * to one (the "ship a selector instead" case of happyvertical/smrt#3599).
 */

import type { RelationOption } from '@happyvertical/smrt-svelte/forms';
import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import type {
  CustomerDisplayData,
  VendorDisplayData,
} from '../upstream/partyTypes.ts';
import { displayLabel, partyField, recordName } from './display.ts';
import { labelKey } from './format.ts';
import type { DataSource, ModelRecord } from './source.ts';

export const PROFILE = '@happyvertical/smrt-profiles:Profile';
export const CUSTOMER = '@happyvertical/smrt-commerce:Customer';
export const VENDOR = '@happyvertical/smrt-commerce:Vendor';

const SEARCH_LIMIT = 20;

function modelNamed(qualified: string): CatalogModel {
  const found = getModelByQualifiedName(qualified);
  if (!found) throw new Error(`The catalog has no model ${qualified}`);
  return found.model;
}

/** The first eight characters of an id: what is left when nothing names it. */
export function shortId(id: unknown): string {
  return String(id ?? '').slice(0, 8);
}

/** Does the model get its name from a Profile (`profileId` referencing one)? */
export function isProfileLabelled(model: CatalogModel): boolean {
  return model.fields.some(
    (f) => f.name === 'profileId' && f.related === PROFILE,
  );
}

async function profileOf(
  source: DataSource,
  record: ModelRecord,
): Promise<ModelRecord | undefined> {
  return typeof record.profileId === 'string' && record.profileId
    ? source.get(modelNamed(PROFILE), record.profileId)
    : undefined;
}

/** How many relations deep a label may reach (allocation > invoice > customer). */
const LABEL_DEPTH = 3;

/** The text that names one record. Never an empty string. */
export async function recordLabel(
  source: DataSource,
  model: CatalogModel,
  record: ModelRecord,
  depth = 0,
): Promise<string> {
  if (isProfileLabelled(model)) {
    const profile = await profileOf(source, record);
    const name = profile && displayLabel(modelNamed(PROFILE), profile);
    if (name) return name;
  }
  const party = partyField(model.fields, record);
  const target = party?.related
    ? getModelByQualifiedName(party.related)?.model
    : undefined;
  let partyLabel: string | undefined;
  if (party && target && depth < LABEL_DEPTH) {
    const found = await source.get(target, String(record[party.name]));
    if (found) {
      partyLabel = await recordLabel(source, target, found, depth + 1);
    }
  }
  return recordName(model, record, () => partyLabel) ?? shortId(record.id);
}

/**
 * The labels of every record the `fields` of `rows` point at, keyed by
 * {@link labelKey}. A pointer to a record that is gone has no entry, so a view
 * falls back to a short id rather than showing nothing.
 */
export async function relationLabels(
  source: DataSource,
  fields: readonly CatalogField[],
  rows: readonly ModelRecord[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const field of fields) {
    const targetId = field.related;
    if (!targetId) continue;
    const target = getModelByQualifiedName(targetId)?.model;
    if (!target) continue;
    const ids = new Set(
      rows
        .map((row) => row[field.name])
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    );
    for (const id of ids) {
      if (labels.has(labelKey(targetId, id))) continue;
      const record = await source.get(target, id);
      if (record) {
        labels.set(
          labelKey(targetId, id),
          await recordLabel(source, target, record),
        );
      }
    }
  }
  return labels;
}

const matches = (text: string, query: string) =>
  text.toLowerCase().includes(query.trim().toLowerCase());

/** Generic relation search: records of `target` whose label matches. */
export async function searchRelated(
  source: DataSource,
  target: CatalogModel,
  query: string,
): Promise<RelationOption[]> {
  const found: RelationOption[] = [];
  for (const record of await source.list(target)) {
    const label = await recordLabel(source, target, record);
    if (matches(label, query)) found.push({ id: record.id, label });
    if (found.length >= SEARCH_LIMIT) break;
  }
  return found;
}

/** One related record as an option, or null when it is gone. */
export async function resolveRelated(
  source: DataSource,
  target: CatalogModel,
  id: string,
): Promise<{ id: string; label: string } | null> {
  const record = await source.get(target, id);
  return record
    ? { id: record.id, label: await recordLabel(source, target, record) }
    : null;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

async function profileData(source: DataSource, record: ModelRecord) {
  const profile = await profileOf(source, record);
  return {
    ...(profile ? { id: profile.id } : {}),
    name:
      (profile && displayLabel(modelNamed(PROFILE), profile)) ??
      shortId(record.id),
    ...(text(profile?.email) ? { email: text(profile?.email) } : {}),
  };
}

/** A Customer row joined to its Profile, as the commerce party DTO. */
export async function customerData(
  source: DataSource,
  record: ModelRecord,
): Promise<CustomerDisplayData> {
  return {
    id: record.id,
    ...(text(record.profileId) ? { profileId: text(record.profileId) } : {}),
    profile: await profileData(source, record),
    status: text(record.status) ?? '',
    ...(text(record.customerType)
      ? { customerType: text(record.customerType) }
      : {}),
    ...(typeof record.creditLimit === 'number'
      ? { creditLimitMinor: record.creditLimit }
      : {}),
    ...(text(record.paymentTerms)
      ? { paymentTerms: text(record.paymentTerms) }
      : {}),
  };
}

/** A Vendor row joined to its Profile, as the commerce party DTO. */
export async function vendorData(
  source: DataSource,
  record: ModelRecord,
): Promise<VendorDisplayData> {
  return {
    id: record.id,
    ...(text(record.profileId) ? { profileId: text(record.profileId) } : {}),
    profile: await profileData(source, record),
    status: text(record.status) ?? '',
    ...(typeof record.leadTimeDays === 'number'
      ? { leadTimeDays: record.leadTimeDays }
      : {}),
    ...(text(record.currency) ? { currency: text(record.currency) } : {}),
  };
}

/** Customers whose profile name (or email) matches, joined to their Profiles. */
export async function searchCustomers(
  source: DataSource,
  query: string,
): Promise<CustomerDisplayData[]> {
  const found: CustomerDisplayData[] = [];
  for (const record of await source.list(modelNamed(CUSTOMER))) {
    const data = await customerData(source, record);
    if (matches(data.profile.name, query)) found.push(data);
    if (found.length >= SEARCH_LIMIT) break;
  }
  return found;
}

export async function resolveCustomer(
  source: DataSource,
  id: string,
): Promise<CustomerDisplayData | null> {
  const record = await source.get(modelNamed(CUSTOMER), id);
  return record ? customerData(source, record) : null;
}

export async function searchVendors(
  source: DataSource,
  query: string,
): Promise<VendorDisplayData[]> {
  const found: VendorDisplayData[] = [];
  for (const record of await source.list(modelNamed(VENDOR))) {
    const data = await vendorData(source, record);
    if (matches(data.profile.name, query)) found.push(data);
    if (found.length >= SEARCH_LIMIT) break;
  }
  return found;
}

export async function resolveVendor(
  source: DataSource,
  id: string,
): Promise<VendorDisplayData | null> {
  const record = await source.get(modelNamed(VENDOR), id);
  return record ? vendorData(source, record) : null;
}

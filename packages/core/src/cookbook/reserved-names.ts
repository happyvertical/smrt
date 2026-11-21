/**
 * Names a field must not take because the object runtime already uses them.
 *
 * The model-field rule (instance members, prototype members, constructor
 * flags) lives in `@happyvertical/smrt-scanner/types` so the scanner,
 * `@field` registration and this editor list share one source. The app model
 * editor additionally rejects every constructor option key and JavaScript,
 * SQL and framework words for custom fields.
 *
 * Type-only imports from core plus a pure-data scanner module: this module has
 * no registry, database or host dependency, so the browser-safe cookbook
 * engine can import it.
 */
import {
  SMRT_INSTANCE_MEMBERS,
  SMRT_OPTION_KEYS,
  SMRT_RESERVED_FIELD_NAMES,
} from '@happyvertical/smrt-scanner/types';
import type { SmrtClassOptions } from '../class.js';
import type { SmrtObjectOptions } from '../object.js';

export { SMRT_INSTANCE_MEMBERS, SMRT_OPTION_KEYS };

/**
 * Compile-time parity: the shared option-key list must equal every
 * `SmrtObjectOptions` / `SmrtClassOptions` key. Adding an option without
 * listing it in the scanner module (or listing a key that no longer exists)
 * fails typecheck.
 */
// `SmrtObjectOptions` carries a `[key: string]: any` index signature (field
// values ride along), so only the declared keys are compared.
type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K
    ? never
    : number extends K
      ? never
      : K]: T[K];
};
type OptionKey =
  | DeclaredKeys<SmrtObjectOptions>
  | DeclaredKeys<SmrtClassOptions>;
type ListedOptionKey = (typeof SMRT_OPTION_KEYS)[number];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const optionKeysMatch: Same<OptionKey, ListedOptionKey> = true;
void optionKeysMatch;

/** JavaScript, SQL and framework column names no custom field may take. */
export const RESERVED_IDENTIFIERS: readonly string[] =
  '__proto__ prototype constructor id slug context tenantId displayLabel createdAt updatedAt metaType metaData _meta_type _meta_data abstract arguments await boolean break byte case catch char class const continue debugger default delete do double else enum eval export extends false final finally float for function goto if implements import in instanceof int interface let long native new null package private protected public return short static super switch synchronized this throw throws transient true try typeof var void volatile while with yield save initialize toJSON toPublicJSON then select from to where table column group order insert update values join limit offset drop alter create index primary foreign key references'.split(
    ' ',
  );

const RESERVED_FIELD_NAMES = new Set([
  ...SMRT_RESERVED_FIELD_NAMES,
  ...RESERVED_IDENTIFIERS,
  ...SMRT_OPTION_KEYS,
  ...SMRT_INSTANCE_MEMBERS,
]);

/**
 * Whether `name` is reserved for an editor-created custom field: the shared
 * model-field rule plus every option key and the JS/SQL words above.
 * Members a model subclass adds to its prototype are found separately by
 * walking the model's prototype chain.
 */
export function isReservedFieldName(name: string): boolean {
  return RESERVED_FIELD_NAMES.has(name);
}

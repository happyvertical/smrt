/**
 * Names a field must not take because the object runtime already uses them.
 * One place for every consumer: the app model editor rejects them for custom
 * fields, and a decorated-class check can adopt the same list.
 *
 * Type-only imports: this module has no registry, database or host
 * dependency, so the browser-safe cookbook engine can import it.
 */
import type { SmrtClassOptions } from '../class.js';
import type { SmrtObjectOptions } from '../object.js';

/**
 * Every constructor option key. Constructor input mixes options with field
 * values, so a field with one of these names would be read as an option.
 * `satisfies` keeps this list equal to the option interfaces: adding an
 * option without listing it here fails typecheck.
 */
const OPTION_KEYS = {
  _className: true,
  db: true,
  persistence: true,
  fs: true,
  ai: true,
  decisions: true,
  inference: true,
  usage: true,
  logging: true,
  metrics: true,
  pubsub: true,
  sanitization: true,
  signals: true,
  _reuseInitializedDb: true,
  _deferRuntimeInitialization: true,
  id: true,
  slug: true,
  context: true,
  created_at: true,
  updated_at: true,
  _extractingFields: true,
  _skipLoad: true,
  _skipAutoEmbeddings: true,
} satisfies Record<keyof SmrtObjectOptions | keyof SmrtClassOptions, true>;

export const SMRT_OPTION_KEYS: readonly string[] = Object.keys(OPTION_KEYS);

/**
 * Own instance properties a constructed `SmrtObject` carries (they are not on
 * the prototype, so a prototype walk cannot find them). A field with one of
 * these names would be skipped on save and overwrite the property on load.
 * `reserved-names.test.ts` constructs an instance and fails when one is missing.
 */
export const SMRT_INSTANCE_MEMBERS: readonly string[] = [
  'options',
  '_ai',
  '_decisionClient',
  '_decisionClientInitPromise',
  '_aiClientConfig',
  '_aiUserOnUsage',
  '_aiSinkAttribution',
  '_aiUsageResolvedConfig',
  '_tierAiClients',
  '_aiTranscriptClients',
  '_aiTranscriptKeys',
  '_aiCapabilityAnswers',
  '_fs',
  '_db',
  '_dbEngineHint',
  '_className',
  '_signalBus',
  '_registeredAdapters',
  '_aiUsageCollector',
  '_aiUsageHandlers',
  '_aiRunUsageListeners',
  '_aiRunCallCaptures',
  '_aiRunClientHooks',
  '_aiClientLabel',
  '_runtimeServicesInitialized',
  '_runtimeServicesInitPromise',
  '_writeThroughDraft',
  '_writeThroughRead',
  '_writingThrough',
  '_writeThroughOriginalLinks',
  '_displayLabel',
  '_tableName',
  '_loadedRelationships',
  '_persisted',
  '_explicitId',
  '_insertOnly',
  '_insertOnlyPreserveDerivedSlug',
  '_derivedSlug',
  '_derivedSlugBase',
  '_adoptNaturalKey',
  '_id',
  '_slug',
  '_context',
  'created_at',
  'updated_at',
  '_syncMetadata',
  '_generatedValues',
];

/** JavaScript, SQL and framework column names no custom field may take. */
export const RESERVED_IDENTIFIERS: readonly string[] =
  '__proto__ prototype constructor id slug context tenantId displayLabel createdAt updatedAt metaType metaData _meta_type _meta_data abstract arguments await boolean break byte case catch char class const continue debugger default delete do double else enum eval export extends false final finally float for function goto if implements import in instanceof int interface let long native new null package private protected public return short static super switch synchronized this throw throws transient true try typeof var void volatile while with yield save initialize toJSON toPublicJSON then select from to where table column group order insert update values join limit offset drop alter create index primary foreign key references'.split(
    ' ',
  );

const RESERVED_FIELD_NAMES = new Set([
  ...RESERVED_IDENTIFIERS,
  ...SMRT_OPTION_KEYS,
  ...SMRT_INSTANCE_MEMBERS,
]);

/**
 * Whether `name` is reserved for the object runtime. Prototype members
 * (`save`, `delete`, `loadRelated`, …) are found separately by walking the
 * model's prototype chain, which also covers subclasses.
 */
export function isReservedFieldName(name: string): boolean {
  return RESERVED_FIELD_NAMES.has(name);
}

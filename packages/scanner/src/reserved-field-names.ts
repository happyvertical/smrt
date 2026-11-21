/**
 * Field names an `@smrt()` model must not declare, because the object runtime
 * already uses them. This is the one rule shared by the scanner (manifest
 * generation), field registration in smrt-core (`@field` and friends) and the
 * app model editor (core `cookbook/reserved-names.ts`).
 *
 * Pure data with no imports, so browser bundles of smrt-core can load it
 * through `@happyvertical/smrt-scanner/types`.
 *
 * Only names that really collide are rejected:
 * - own instance members of a constructed `SmrtObject` (`options`, `_db`, …):
 *   such a field is skipped on save and overwrites the member on load;
 * - members of the `SmrtObject` / `SmrtClass` prototypes (`db`, `ai`, `fs`,
 *   `save`, `delete`, `toJSON`, `tableName`, …): a class field shadows them;
 * - the underscore constructor flags (`_skipLoad`, …) that steer
 *   initialization.
 * The service option keys that are not members (`metrics`, `logging`,
 * `usage`, `signals`, …) stay available: a declared field with one of those
 * names is row data and never configures the service (smrt-core
 * `service-options.ts`). The framework columns (`id`, `slug`, `context`,
 * `created_at`, `updated_at`) stay available too, and so do ordinary words
 * such as `key`, `order` or `group`: the editor's wider SQL/JavaScript word
 * list applies to custom fields only.
 */

/**
 * Every `SmrtObjectOptions` / `SmrtClassOptions` key. smrt-core asserts at
 * compile time that this list equals the option interfaces, so adding an
 * option without listing it here fails core's typecheck.
 */
export const SMRT_OPTION_KEYS = [
  '_className',
  'db',
  'persistence',
  'fs',
  'ai',
  'decisions',
  'inference',
  'usage',
  'logging',
  'metrics',
  'pubsub',
  'sanitization',
  'signals',
  '_reuseInitializedDb',
  '_deferRuntimeInitialization',
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
  '_extractingFields',
  '_skipLoad',
  '_skipAutoEmbeddings',
] as const;

/** Framework columns a model may declare although the runtime knows them. */
export const SMRT_FRAMEWORK_FIELD_NAMES: readonly string[] = [
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
];

/**
 * Own instance properties a constructed `SmrtObject` carries (they are not on
 * the prototype). smrt-core's `reserved-names.test.ts` constructs an instance
 * and fails when one is missing.
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

/**
 * Own members of `SmrtObject.prototype` and `SmrtClass.prototype` (methods
 * and accessors), except `constructor` and the framework columns. smrt-core's
 * `reserved-names.test.ts` compares this list with the real prototypes in
 * both directions, so a new or removed member fails until it is listed.
 */
export const SMRT_PROTOTYPE_MEMBERS: readonly string[] =
  '_setDisplayLabel _setLoadedRelationship _setWriteThroughRead adoptNaturalKeyOnSave adoptNaturalKeyRow ai aiRunStore aiRunTracked aiTranscriptContext aiTranscriptSecrets aiTranscriptSensitiveValues assertNullableNaturalKeyFree assertRelatedTenant assertSameNaturalKeyOwner attemptDecision buildAiContentSection canonicalizePersistedUuidRow capabilityUsageTags captureGeneratedValues claimRevision clearEmbeddings cloneValue coerceEmptyUuidValuesToNull completePersistedUpdate completeSave currentTenantId db decideForInference delete describe destroy detectInferenceTargetCapabilities do enforceHostedInferenceGate ensureNativeVectorStorage ensureRuntimeServicesInitialized ensureSystemTables evaluate evaluateWithGenerativeClient executeToolCall extractConstraintField extractConstraintFieldFromChain fitAiPrompt forget forgetScope fs generateEmbeddings getAiClient getAiClientForTarget getAiUsageSnapshot getAvailableTools getCanonicalPersistedRow getCanonicalPersistedRows getCurrentMetaType getDatabaseEngineHint getDecisionClient getDecisionConfig getEmbedding getFieldValue getFields getId getInferenceConfig getInferenceStatus getOptionalAiClient getPersistenceDerivedColumns getPropertyValue getPublicFieldPolicies getRegisteredClassInfo getRelated getResolvedClassName getResolvedQualifiedName getSavedId getSlug getUntrackedAiClientForTarget guardedWriteFilter handleAiUsageCallback hasStaleEmbeddings hostedGateRequest hydrateSyncMetadata hydrateWriteThrough inferenceRequestScope inferenceUserScope initialize initializeAiUsageHandlers initializeCoreResources initializePropertiesFromOptions initializeRuntimeServices initializeSignals insertIfAbsent installWriteThroughFields interceptGetFilter invalidateCollectionReadCache is isInferenceAvailable isLegacySTIDiscriminatorUpgrade isNativeDuckDb isPersisted isPositivelyNativeDuckDb isRelatedLoaded isSaved isSystemSchemaVersionApplied isTenantContractError listAiUsage loadDataFromDb loadFromId loadFromSlug loadRelated loadRelatedMany lookupInferenceFusion markAsPersisted mergeAiUsageConfig mergeSignalConfig moveToFreeDerivedSlug needsPropertyInitialization nextRevisionTimestamp nextSyncMetadata normalizePersistenceData normalizeSyncRowId notifyRunUsage observeRunUsage openInferenceRun persistWriteThrough planPersistenceWrite prepareAiOperation prepareSave projectPublicJSON readNativeDuckDbRows readNaturalKeyRow readWriteThroughVirtual recall recallAll recordAiUsageEvent recordInferenceUsage registerAdapters remember requireConfiguredAi requireInsertOnSave requiresDatabase resetAiUsage resolveAiClient resolveInferenceModeState resolveInferenceTier resolveManyToManyJoin resolveUuidColumnNames revisionPredicate revisionPredicateValue revisionsEqual runHook save saveWriteThroughVirtual scopePartialConflictFilter sdkCapabilities serializeForAiPrompt setId setMetaType settleDeferredSystemTableCompatibility shapeAiRequest shapedMessageOptions shouldBroadcastCacheInvalidation shouldInitializeSignals signalBus summarizeAiUsage supportsBatchCreate supportsBatchLifecycle supportsJunctionBatch syncMetadata systemDb tableName toJSON toPlainObject toPublicJSON toTypedWriteError trackedIdentityWriteError transcriptClient transformJSON unchangedIndexedColumnsOf updateDuckDbRowById validateBeforeSave validateCrossPackageRefs validateTypedStiReferences verifyStorageReady warmChangeFeedOwnerFields withAiUsage withDatabase withTransaction writeEmbeddedRevisionRow writeNaturalKeyRow writeNaturalKeyUpsert writeThroughDefaults'.split(
    ' ',
  );

const FRAMEWORK_FIELDS = new Set(SMRT_FRAMEWORK_FIELD_NAMES);
const INTERNAL_OPTION_KEYS = SMRT_OPTION_KEYS.filter((key) =>
  key.startsWith('_'),
);

/** Names no model field may take. */
export const SMRT_RESERVED_FIELD_NAMES: readonly string[] = [
  ...new Set([
    ...SMRT_INSTANCE_MEMBERS,
    ...SMRT_PROTOTYPE_MEMBERS,
    ...INTERNAL_OPTION_KEYS,
  ]),
].filter((name) => !FRAMEWORK_FIELDS.has(name));

const RESERVED = new Set(SMRT_RESERVED_FIELD_NAMES);

/** Whether a model field may not be named `name`. */
export function isReservedModelFieldName(name: string): boolean {
  return RESERVED.has(name);
}

/**
 * The error a scan or registration reports for a reserved field name. It
 * names the model, the field and the fix.
 */
export function reservedFieldNameMessage(
  modelName: string,
  fieldName: string,
): string {
  const role = SMRT_PROTOTYPE_MEMBERS.includes(fieldName)
    ? 'a SmrtObject method or accessor'
    : fieldName.startsWith('_') && !SMRT_INSTANCE_MEMBERS.includes(fieldName)
      ? 'a constructor flag'
      : 'an instance member of every SmrtObject';
  return `Model ${modelName} declares a field named "${fieldName}", which is ${role}; such a field is not stored or loaded as data and overrides what the runtime keeps under that name. Rename the field (for example "${fieldName.replace(/^_+/, '')}Value" or a domain name); if the table already has a column for it, add a migration that renames the column.`;
}

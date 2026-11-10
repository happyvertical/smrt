import './__smrt-register__.js';

export type {
  CourseLicenseKind,
  CourseModality,
  CourseStatus,
  CourseVisibility,
  LessonCompletionRule,
} from './catalog.js';
export {
  AuthoredCourse,
  COURSE_VISIBILITIES,
  Course,
  CourseSection,
  Exercise,
  ExternalCourse,
  Lesson,
  Reading,
  Video,
  Worksheet,
} from './catalog.js';
export type {
  CatalogAcquisitionRecord,
  CatalogAcquisitionRequest,
  CatalogAcquisitionStore,
} from './catalog-acquisition-service.js';
export { CatalogAcquisitionService } from './catalog-acquisition-service.js';
export {
  CatalogRepresentationError,
  evaluateCatalogAcquisitionCapability,
  normalizeCatalogRepresentation,
} from './catalog-capability.js';
export {
  CatalogAcquisitionCollection,
  CatalogProviderCollection,
  CatalogResourceCollection,
  CatalogSelectionCollection,
  CatalogSyncStateCollection,
} from './catalog-collections.js';
export type {
  CatalogAcquireAdapter,
  CatalogAcquisitionCapabilityDecision,
  CatalogActor,
  CatalogLicenseEvidence,
  CatalogLicenseState,
  CatalogOperation,
  CatalogResourceRepresentation,
  CatalogSourceRecord,
  CatalogSyncAdapter,
  CatalogSyncCheckpoint,
  CatalogSyncFailure,
  CatalogSyncPage,
  CatalogVisibility,
} from './catalog-contracts.js';
export { CatalogDatabaseSyncStore } from './catalog-database-sync-store.js';
export type {
  CatalogEnrollmentPort,
  CatalogMaterializationAuthorizer,
  CatalogMaterializationRequest,
  CatalogMaterializationResult,
  CatalogMaterializationStorage,
  CatalogMaterializationStore,
} from './catalog-materialization-service.js';
export { CatalogMaterializationService } from './catalog-materialization-service.js';
export {
  CatalogAcquisition,
  CatalogProvider,
  CatalogResource,
  CatalogSelection,
  CatalogSyncState,
} from './catalog-models.js';
export type { CatalogPolicyDecision } from './catalog-policy.js';
export { CatalogPolicy } from './catalog-policy.js';
export type {
  CatalogPreview,
  CatalogPreviewLoader,
  CatalogPreviewStore,
} from './catalog-preview.js';
export {
  CATALOG_PREVIEW_MAX_BYTES,
  CATALOG_PREVIEW_MAX_DIMENSION,
  CatalogPreviewService,
  catalogPreviewFor,
  normalizeCatalogPreview,
} from './catalog-preview.js';
export type {
  CatalogReadStore,
  CatalogResourceView,
} from './catalog-read-service.js';
export { CatalogReadService } from './catalog-read-service.js';
export type {
  CatalogActorContext,
  CatalogAuthorizer,
  CatalogReadRequest,
  TenantCatalogReadScope,
} from './catalog-service.js';
export {
  CatalogAuthorizationError,
  CatalogService,
} from './catalog-service.js';
export type {
  CatalogExclusionSummary,
  CatalogFailureSummary,
  CatalogSyncReport,
  CatalogSyncStore,
} from './catalog-sync-service.js';
export { CatalogSyncService } from './catalog-sync-service.js';
export {
  AttestationCollection,
  AuthoredCourseCollection,
  CourseCollection,
  CourseSectionCollection,
  CurriculumCollection,
  EnrollmentCollection,
  ExerciseCollection,
  ExternalCompletionCollection,
  ExternalCourseCollection,
  GradeCollection,
  LearnerCollection,
  LessonAssetCollection,
  LessonCollection,
  LessonProgressCollection,
  LessonSelfAttestationCollection,
  ReadingCollection,
  ScannedSubmissionCollection,
  SubmissionAssetCollection,
  SubmissionCollection,
  SubmissionIntakeBindingCollection,
  VideoCollection,
  WorksheetCollection,
} from './collections.js';
export * from './course-authoring-contracts.js';
export {
  AUTHORED_IDENTITY_SOURCE_KEY,
  AUTHORED_RELEASE_SOURCE_KEY,
  isAuthoredReleaseGroupShareable,
  isGroupShareableLicense,
  mostRestrictiveLicense,
} from './course-authoring-licence.js';
export * from './course-authoring-models.js';
export type { CourseAuthoringServiceOptions } from './course-authoring-service.js';
export { CourseAuthoringService } from './course-authoring-service.js';
export {
  type BundleMaterial,
  type BundleMaterialsPlan,
  type BundlePage,
  type BundleReader,
  BundleReaderRegistry,
  type BundleStructure,
  type BundleStructureLesson,
  type BundleStructureSection,
  type BundleVideo,
  bundleProposalOutput,
  type ClassifiedBundleMember,
  type CourseBundlePlan,
  classifyBundle,
  classifyBundleMember,
  courseBundleIdentity,
  createBundleReaderRegistry,
  manifestBundleReader,
  manifestV2BundleReader,
  naturalCompare,
  type OfficeOutcome,
  type PreparedBundle,
  parseBundleManifest,
  pdfIsEncrypted,
  plainBundleReader,
  planBundleMaterials,
  planClassifiedBundle,
  planCourseBundle,
  type RenderedThumbnail,
  sniffImageMediaType,
  unpackBundle,
} from './course-bundle.js';
export * from './course-bundle-contracts.js';
export * from './course-bundle-manifest-v2.js';
export * from './course-bundle-models.js';
export {
  type AcceptedCourseBundleMember,
  type ApplyBundleMaterialsRequest,
  type ApplyBundleMaterialsResult,
  type AttachBundleCourseRequest,
  type AttachBundleCourseResult,
  BUNDLE_COURSE_SOURCE,
  type BundleMemberAssets,
  type ChooseMaterialAudienceRequest,
  type CourseBundleAudienceChoiceView,
  type CourseBundleImportResult,
  CourseBundleImportService,
  type CourseBundleImportServiceOptions,
  type CourseBundleImportView,
  CourseBundleMaterialsError,
  type CourseBundleMemberView,
  type ImportCourseBundleRequest,
  type ProposeBundleStructureRequest,
  type RetryBundleRenderingRequest,
  type RetryBundleRenderingResult,
} from './course-bundle-service.js';
export {
  normalizeBundlePath,
  type RawBundleMember,
  readFileSet,
  readZipArchive,
} from './course-bundle-zip.js';
export * from './course-generation-contracts.js';
export * from './course-generation-models.js';
export {
  applyProposalFields,
  draftFromRevision,
  planProposal,
  validateCourseGenerationOutput,
} from './course-generation-output.js';
export {
  COURSE_LESSON_PROPOSAL_ARGS_SCHEMA,
  COURSE_PROPOSAL_ARGS_SCHEMA,
  COURSE_PROPOSAL_HANDLER,
  createProposalCourseGenerator,
  describeGenerationBrief,
} from './course-generation-proposal-generator.js';
export type { CourseGenerationReviewServiceOptions } from './course-generation-review-service.js';
export { CourseGenerationReviewService } from './course-generation-review-service.js';
export * from './course-review-contracts.js';
export { courseReviewContextDigest } from './course-review-digest.js';
export type {
  FixtureReviewer,
  ReviewEvaluationCaseResult,
  ReviewEvaluationReport,
  ReviewerFinding,
  ReviewFixtureCase,
  ReviewFixtureMaterial,
  SeededFlaw,
} from './course-review-evaluation.js';
export { evaluateReviewer } from './course-review-evaluation.js';
export {
  createCourseReferenceGuard,
  createReviewBackedReleaseGate,
} from './course-review-gate.js';
export * from './course-review-models.js';
export type {
  CourseSourceConfig,
  CourseSourceKind,
  SourceSharing,
} from './course-source.js';
export { CourseSource, CourseSourceCollection } from './course-source.js';
export {
  authoredVisibilityPermitsGroups,
  effectiveCourseVisibility,
} from './course-visibility.js';
export type { WorkbookMigrationReport } from './course-work-migration.js';
export { migrateWorkbooksToCourses } from './course-work-migration.js';
export * from './document-converter.js';
export type { EnrollmentParentNoteView } from './enrollment-note-service.js';
export {
  ENROLLMENT_NOTE_MAX_LENGTH,
  EnrollmentParentNote,
  EnrollmentParentNoteCollection,
  validateEnrollmentNote,
} from './enrollment-notes.js';
export * from './family-intake-contracts.js';
export {
  FamilyIntake,
  FamilyIntakeAsset,
  FamilyIntakeAssetCollection,
  FamilyIntakeCollection,
  FamilyIntakeDecision,
  FamilyIntakeDecisionCollection,
} from './family-intake-models.js';
export type {
  GroupSharingAction,
  GroupSharingAuthorizer,
} from './group-sharing-authorization.js';
export type {
  AddRevisionCommentRequest,
  ListRevisionCommentsRequest,
  SetCommentChildVisibilityRequest,
} from './group-sharing-comments.js';
export * from './group-sharing-contracts.js';
export * from './group-sharing-models.js';
export { evaluateGroupSharingPolicy } from './group-sharing-policy.js';
export { GroupSharingService } from './group-sharing-service.js';
export { isGroupTenant } from './group-sharing-workspace.js';
export type {
  AuthorizedCatalogFeed,
  HearthCatalogProviderId,
  OerCommonsRssConfig,
  ProviderFeedRequirement,
  ProviderMetadataFetch,
  ProviderMetadataResponse,
  PublicIllustrativeMathematicsK5Config,
} from './hearth-catalog-providers.js';
export {
  createCk12Adapter,
  createIllustrativeMathematicsAdapter,
  createOerCommonsAdapter,
  createOerCommonsRssAdapter,
  createPublicIllustrativeMathematicsK5Adapter,
  providerFeedRequirements,
} from './hearth-catalog-providers.js';
export * from './hearth-class-crunchlabs.js';
export type {
  EasyPeasyGrade4Course,
  EasyPeasyGrade4Theme,
  EasyPeasyGrade4Variant,
  EasyPeasyThemeImportResult,
} from './hearth-easy-peasy-grade4.js';
export {
  easyPeasyGrade4Courses,
  easyPeasyGrade4Themes,
  grade4Courses,
  grade4Theme,
  importEasyPeasyGrade4Course,
  importEasyPeasyGrade4Theme,
} from './hearth-easy-peasy-grade4.js';
export type { LessonProgressTransitionKind } from './learner-history.js';
export {
  EnrollmentPaceChange,
  EnrollmentPaceChangeCollection,
  EnrollmentStatusChange,
  EnrollmentStatusChangeCollection,
  LearnerInterestThemeChange,
  LearnerInterestThemeChangeCollection,
  LessonCompletionRecord,
  LessonCompletionRecordCollection,
  LessonProgressTransition,
  LessonProgressTransitionCollection,
} from './learner-history.js';
export type {
  InterestTheme,
  InterestThemeInput,
} from './learner-interest-theme.js';
export {
  interestThemeFromColumns,
  MAX_INTEREST_THEME_KEY_CHARS,
  MAX_INTEREST_THEME_LABEL_CHARS,
  parseInterestTheme,
} from './learner-interest-theme.js';
export type {
  EnrollmentPlanView,
  PlanLessonView,
} from './learner-plan-service.js';
export { LearnerPlanService } from './learner-plan-service.js';
export type {
  CompleteOwnLessonResult,
  CurriculumView,
  EnrollmentPace,
  EnrollmentView,
  LearnerAuthorizer,
  LearnerRequest,
  LearnerSetupStatus,
  LearnerSetupStatusRequest,
  LearnerView,
  LessonProgressView,
  PutBackLessonResult,
  SetEnrollmentPaceResult,
  SetEnrollmentStatusResult,
  SetInterestThemeResult,
} from './learner-service.js';
export {
  ENROLLMENT_STATUS_TRANSITIONS,
  EnrollmentNotActiveError,
  EnrollmentPaceError,
  EnrollmentStatusTransitionError,
  InterestThemeError,
  LearnerAuthorizationError,
  LearnerHistoryUnavailableError,
  LearnerService,
  LearnerValidationError,
  LessonAlreadyCompleteError,
  LessonPutBackError,
  LessonSkippedError,
  LessonWorkOwnedError,
  MAX_LESSONS_PER_WEEK,
  MAX_NEXT_LESSONS_COUNT,
  MIN_LESSONS_PER_WEEK,
  requirePolicyBasis,
} from './learner-service.js';
export type { EnrollmentStatus, LessonProgressStatus } from './learners.js';
export { Curriculum, Enrollment, Learner, LessonProgress } from './learners.js';
export * from './lesson-assets.js';
export * from './lesson-pages.js';
export {
  WorkCompletionDecision,
  WorkCompletionDecisionCollection,
} from './lesson-work-completion.js';
export * from './lesson-work-contracts.js';
export * from './lesson-work-models.js';
export { LessonWorkService } from './lesson-work-service.js';
export type { QuestionAuthoringServiceOptions } from './question-authoring-service.js';
export { QuestionAuthoringService } from './question-authoring-service.js';
export {
  type NormalizedQuestionContent,
  normalizeQuestionContent,
} from './question-content.js';
export * from './question-contracts.js';
export {
  extractedQuestionContent,
  matchExtractedQuestions,
  normalizeQuestionExtraction,
  QUESTION_EXTRACTION_ARGS_SCHEMA,
  questionExtractionSourceIdentity,
} from './question-extraction.js';
export * from './question-extraction-contracts.js';
export * from './question-extraction-models.js';
export {
  type PreserveQuestionExtractionRequest,
  QuestionExtractionService,
  questionExtractionProposalDigest,
} from './question-extraction-service.js';
export * from './question-models.js';
export {
  renderGuardianWorksheetPdf,
  renderLearnerWorksheetPdf,
} from './question-printable.js';
export {
  buildGuardianWorksheet,
  buildLearnerWorksheet,
  type WorksheetRenderInput,
  worksheetVersionId,
} from './question-render.js';
export * from './question-response-contracts.js';
export type {
  GuardianCorrectionRequest,
  RecordQuestionResponseRequest,
} from './question-response-service.js';
export { QuestionResponseService } from './question-response-service.js';
export {
  parseQuestionRubric,
  validateRubricResults,
} from './question-rubric.js';
export {
  EducationCatalogRecipe,
  EducationLearnerRecipe,
  EducationSupervisorRecipe,
} from './recipes.js';
export type {
  EasyPeasyRegistration,
  EnsureEasyPeasyCourseSourceRequest,
  EnsureEasyPeasyCourseSourceResult,
  SourceImportAuthorization,
  SourceImportAuthorizer,
  SourceImportRequest,
  SourceImportResult,
} from './source-import-service.js';
export { SourceImportService } from './source-import-service.js';
export * from './sources/class-crunchlabs.js';
export type {
  ParsedSourceCourse,
  ParsedSourceLesson,
} from './sources/easy-peasy-parser.js';
export {
  parseEasyPeasyPage,
  validateEasyPeasyUrl,
} from './sources/easy-peasy-parser.js';
export type {
  DriveCatalogRecord,
  DriveDiscoveryCheckpoint,
  DriveDiscoveryOptions,
  DriveDiscoveryPage,
  DriveExclusion,
  DriveSelectionAuthorization,
  GoogleDriveFilesClient,
  PinnedDriveContent,
} from './sources/google-drive-adapter.js';
export {
  DRIVE_CURRICULUM_SEED_ROOTS,
  GoogleDriveCurriculumAdapter,
} from './sources/google-drive-adapter.js';
export { parseIllustrativeMathematicsK5Index } from './sources/illustrative-mathematics-parser.js';
export { parseOerCommonsRssFeed } from './sources/oer-commons-rss-parser.js';
export type { PublicIllustrativeMathematicsFirstEditionConfig } from './sources/public-illustrative-mathematics-adapter.js';
export { createPublicIllustrativeMathematicsFirstEditionAdapter } from './sources/public-illustrative-mathematics-adapter.js';
export type {
  LessonMaterialView,
  LessonStepKind,
  LessonStepsView,
  LessonStepView,
  SubmissionAssetClaim,
  SubmissionIntake,
  SubmissionPage,
  SubmissionServiceOptions,
  SubmissionView,
} from './submission-service.js';
export {
  LessonWorkWorkflowRequiredError,
  OwnAttestationConflictError,
  OwnAttestationLessonKindError,
  SELF_ATTESTABLE_LESSON_KINDS,
  SubmissionService,
  SubmissionStorageCleanupError,
  submissionPageKey,
} from './submission-service.js';
export type {
  ExternalCompletionReporter,
  GraderKind,
  SubmissionAssetRelationship,
  SubmissionKind,
  SubmissionStatus,
} from './submissions.js';
export {
  Attestation,
  ExternalCompletion,
  Grade,
  LessonSelfAttestation,
  ScannedSubmission,
  Submission,
  SubmissionAsset,
  SubmissionIntakeBinding,
} from './submissions.js';
export type { TutorContextRequest } from './tutor-context-service.js';
export { TutorContextService } from './tutor-context-service.js';
export * from './tutor-contracts.js';
export {
  TutorExchange,
  TutorExchangeCollection,
  TutorSession,
  TutorSessionClosure,
  TutorSessionClosureCollection,
  TutorSessionCollection,
} from './tutor-models.js';
export type {
  AppendTutorExchangeRequest,
  ListTutorSessionsRequest,
  OpenTutorSessionRequest,
  TutorExchangeView,
  TutorSessionView,
  TutorSessionWithExchanges,
} from './tutor-session-service.js';
export { TutorSessionService } from './tutor-session-service.js';
export { normalizeWorkAnswerRegions } from './work-answer-regions.js';
export * from './work-layout.js';
export * from './workbook-photo-contracts.js';
export * from './workbook-photo-models.js';
export { WorkbookPhotoService } from './workbook-photo-service.js';

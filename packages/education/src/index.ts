import './__smrt-register__.js';

export type {
  CourseLicenseKind,
  CourseModality,
  CourseStatus,
  LessonCompletionRule,
} from './catalog.js';
export {
  AuthoredCourse,
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
  CatalogAcquisitionCollection,
  CatalogProviderCollection,
  CatalogResourceCollection,
  CatalogSelectionCollection,
  CatalogSyncStateCollection,
} from './catalog-collections.js';
export type {
  CatalogAcquireAdapter,
  CatalogActor,
  CatalogLicenseEvidence,
  CatalogLicenseState,
  CatalogOperation,
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
  ReadingCollection,
  ScannedSubmissionCollection,
  SubmissionAssetCollection,
  SubmissionCollection,
  SubmissionIntakeBindingCollection,
  VideoCollection,
  WorksheetCollection,
} from './collections.js';
export type {
  CourseSourceConfig,
  CourseSourceKind,
  SourceSharing,
} from './course-source.js';
export { CourseSource, CourseSourceCollection } from './course-source.js';
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
export type {
  CurriculumView,
  EnrollmentView,
  LearnerAuthorizer,
  LearnerRequest,
  LearnerSetupStatus,
  LearnerSetupStatusRequest,
  LearnerView,
  LessonProgressView,
} from './learner-service.js';
export {
  LearnerAuthorizationError,
  LearnerService,
} from './learner-service.js';
export type { EnrollmentStatus, LessonProgressStatus } from './learners.js';
export { Curriculum, Enrollment, Learner, LessonProgress } from './learners.js';
export type { LessonAssetRelationship } from './lesson-assets.js';
export { LessonAsset } from './lesson-assets.js';
export { EducationCatalogRecipe, EducationLearnerRecipe } from './recipes.js';
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
  SubmissionAssetClaim,
  SubmissionIntake,
  SubmissionPage,
  SubmissionServiceOptions,
  SubmissionView,
} from './submission-service.js';
export {
  SubmissionService,
  SubmissionStorageCleanupError,
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
  ScannedSubmission,
  Submission,
  SubmissionAsset,
  SubmissionIntakeBinding,
} from './submissions.js';

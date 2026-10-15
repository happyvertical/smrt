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
  CatalogActorContext,
  CatalogAuthorizer,
  CatalogReadRequest,
  TenantCatalogReadScope,
} from './catalog-service.js';
export {
  CatalogAuthorizationError,
  CatalogService,
} from './catalog-service.js';
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
  VideoCollection,
  WorksheetCollection,
} from './collections.js';
export type {
  CurriculumView,
  EnrollmentView,
  LearnerAuthorizer,
  LearnerRequest,
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
  SubmissionAssetClaim,
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
  SubmissionStatus,
} from './submissions.js';
export {
  Attestation,
  ExternalCompletion,
  Grade,
  ScannedSubmission,
  Submission,
  SubmissionAsset,
} from './submissions.js';

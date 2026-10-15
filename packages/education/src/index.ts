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
  AuthoredCourseCollection,
  CourseCollection,
  CourseSectionCollection,
  ExerciseCollection,
  ExternalCourseCollection,
  LessonAssetCollection,
  LessonCollection,
  ReadingCollection,
  VideoCollection,
  WorksheetCollection,
} from './collections.js';
export type {
  CourseSourceConfig,
  CourseSourceKind,
  SourceSharing,
} from './course-source.js';
export { CourseSource, CourseSourceCollection } from './course-source.js';
export type { LessonAssetRelationship } from './lesson-assets.js';
export { LessonAsset } from './lesson-assets.js';
export { EducationCatalogRecipe } from './recipes.js';
export type {
  EasyPeasyRegistration,
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

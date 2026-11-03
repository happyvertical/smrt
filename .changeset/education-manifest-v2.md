---
'@happyvertical/smrt-education': minor
---

Course bundle manifest version 2: a closed schema with material roles and audience (answer keys and assessment guidance always guardian-only), lesson page ranges, course-level members and allowlisted YouTube references. `CourseBundleImportService.applyMaterials` writes `CourseAsset`, `LessonAsset` (slides keep the original deck and the rendered pages), `LessonPage` and `LessonExternalVideo`; `retryRendering` deliberately and idempotently repairs a transient converter failure; `createOfficeTextReader` adapts the SDK `extractOffice`. Breaking: member evidence gains `audience`, `course_bundle_renderings` is a new table, and `AcceptedCourseBundleMember` gains `audience` and `courseLevel`.

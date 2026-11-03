# Lesson materials and audience

Design record: [course work](course-work-design.md). Models are closed (no REST,
CLI, MCP or AI surface); reads and writes go through `SubmissionService` (and its
`LessonWorkService` subclass) with the usual actor, learner and enrollment checks.

## Roles and audience

`LessonAssetRelationship` (`LESSON_ASSET_RELATIONSHIPS`): `teacher-guide`, `slides`,
`learner-pages`, `assessment`, `assessment-guidance`, `handout`, `printable`,
`answer-key`, `video`, `attachment`. Each `LessonAsset`, `CourseAsset` and
`LessonExternalVideo` row has `audience: 'learner' | 'guardian'`; `''` means the role
default (`LESSON_ASSET_DEFAULT_AUDIENCE`): guardian for teacher-guide, slides,
assessment-guidance and answer-key, learner otherwise. `materialAudience(role,
audience?)` resolves and validates it. `answer-key` and `assessment-guidance`
(`GUARDIAN_ONLY_RELATIONSHIPS`) can never be learner-audience and, like any join in
a personal-use-copy course, require a private asset under the host's exact
actor/owner/asset capability.

`CourseAsset` holds course-level material (supply list, posters) with the same
roles, audience and private-asset rule, plus an optional title.

## Learner never sees guardian material

`listLessonMaterials({enrollmentId, lessonId})` and `listCourseMaterials({enrollmentId})`
return `LessonMaterialView`s (`id`, `kind` file or external-video, `scope`, role,
audience, title, order, `assetId` or provider/videoId/`embedUrl`). The learner
themself sees only learner-audience rows; an authorized guardian sees all. The
catalog projection without answer keys (every learner-facing catalog read) applies
the same rule. `signLessonMaterial`/`signCourseMaterial` sign only a file in the
actor's own list (claim scope `lesson:<id>` / `course:<id>`); a guessed id of
guardian material is denied. `signLessonPrintable` applies the same audience
rule to the learner. Storage URIs never appear.

`setMaterialAudience({enrollmentId, scope, kind, materialId, audience})` lets a
guardian with plan authority change a family-owned row within the role's bounds.
Authored courses change audience through course authoring (`CourseMaterialInput.audience`,
carried to the released join); shared or other families' rows are denied.

## External videos

`LessonExternalVideo` references a video at an allowlisted provider (YouTube only):
`videoId` (11 characters), title, `stepOrder` and audience. It is never downloaded
and has no Asset row. `parseYouTubeReference` accepts a bare id or an https
youtube.com / m. / music. / youtu.be / youtube-nocookie.com URL (watch, embed,
shorts, live) and nothing else; `externalVideoEmbedUrl` returns the
youtube-nocookie embed URL. `addLessonVideo({enrollmentId, lessonId, reference,
title, stepOrder, audience?})` adds one to a family-owned lesson (plan authority);
the same video with the same details replays, other details conflict, and a
non-allowlisted reference throws `ExternalVideoReferenceError`.

Tests: `src/__tests__/lesson-materials.test.ts`.

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

## Rendition and thumbnail (SMRT #4632)

`LessonAsset` and `CourseAsset` carry `rendition` (`''` a file as supplied,
`original` an editable Word/PowerPoint file, `rendered` the PDF rendered from
one), `renditionOfAssetId` (a rendering's original) and `thumbnailAssetId` (an
optional first-page image, null when no converter drew one). The model refuses
an `original` with a learner audience: the learner gets the rendering, never the
editable file. A new thumbnail must be an asset of the same family, and private
under the host's capability (same owner as the material) whenever the material
must be private.

## Learner never sees guardian material

`listLessonMaterials({enrollmentId, lessonId})` and `listCourseMaterials({enrollmentId})`
return `LessonMaterialView`s (`id`, `kind` file or external-video, `scope`, role,
audience, title (the bundle's material title, else the stored asset's name), order, `assetId` or provider/videoId/`embedUrl`, and for files
`mimeType` from the stored asset, `rendition`, `pairedMaterialId` (the other half
of an original/rendered pair, only when this actor sees both) and
`thumbnailAssetId`). Hosts read these instead of guessing by file extension. The learner
themself sees only learner-audience rows; an authorized guardian sees all. The
catalog projection without answer keys (every learner-facing catalog read) applies
the same rule. `signLessonMaterial`/`signCourseMaterial` sign only a file in the
actor's own list (claim scope `lesson:<id>` / `course:<id>`); a guessed id of
guardian material is denied; `thumbnail: true` signs the thumbnail of a visible
material instead. `signLessonPrintable` signs a lesson file for printing: a `printable`, `handout` or `learner-pages` row (handout and learner pages only when the stored asset is `application/pdf`), learner-audience for a learner and any audience for a guardian. A retired row, an `original` rendition (the editable file) and any other role, answer keys included, are refused (SMRT #4657). Storage URIs never appear.

`setMaterialAudience({enrollmentId, scope, kind, materialId, audience})` lets a
guardian with plan authority change a family-owned row within the role's bounds
(an `original` stays guardian). Bundle courses (`sourceKey` `course-bundle`) are
family-owned, so this is the after-attach path; before attach use
`CourseBundleImportService.chooseMaterialAudience`.
Authored courses change audience through course authoring (`CourseMaterialInput.audience`,
carried to the released join); shared or other families' rows are denied.

## Lesson steps (SMRT #4656)

`listLessonSteps({enrollmentId, lessonId})` walks a multi-step lesson in order,
filtered like `listLessonMaterials` (same actor and enrollment checks, learner
audience only for a learner, retired rows left out, same `LessonMaterialView`s):

```ts
{ setup: LessonMaterialView[];            // stepless printable / handout / learner-pages files
  steps: Array<{ key: string; label: string;   // label falls back to the key
                 kind: 'present' | 'watch' | 'do' | 'check';
                 order: number;                 // 1b sorts after 1
                 materials: LessonMaterialView[] }> }
```

Steps come from the `step_key`/`step_order`/`step_label` recorded on lesson files and
(`step_position`) external videos by a course bundle ([manifest steps](course-bundle-import.md)).
Materials sharing a key are one step (the original and rendered halves of a deck stay
together); steps sort by order then key; `kind` is `present` if any material is
`slides`, else `watch` if any is an external video, else `check` if any is an
`assessment`, else `do`. A lesson with no declared steps returns `steps: []`.
Course-level materials (supply lists) are not part of a lesson listing and stay with
`listCourseMaterials`.

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

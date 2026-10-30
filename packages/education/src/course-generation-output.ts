import type {
  CourseDraftInput,
  CourseLessonInput,
  CourseRevisionView,
} from './course-authoring-contracts.js';
import {
  CourseGenerationOutputError,
  type CourseGenerationProposal,
  type CourseGenerationProposalLesson,
  type CourseProposalFieldStatus,
} from './course-generation-contracts.js';
import { groupSharingDigest } from './group-sharing-hash.js';

const KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const hasControl = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
      return true;
  }
  return false;
};

function closed(
  value: unknown,
  allowed: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CourseGenerationOutputError(path);
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new CourseGenerationOutputError(`${path}.${key}`);
  return value as Record<string, unknown>;
}
function str(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new CourseGenerationOutputError(path);
  if (hasControl(value)) throw new CourseGenerationOutputError(path);
  return value;
}
function int(value: unknown, path: string, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > max
  )
    throw new CourseGenerationOutputError(path);
  return value as number;
}

/**
 * Validates untrusted provider output against the closed proposal schema.
 * `existingLessonKeys` are the lessons of the snapshot the job ran against: a
 * proposal may only address a lesson that exists there.
 */
export function validateCourseGenerationOutput(
  output: unknown,
  existingLessonKeys: ReadonlySet<string>,
): CourseGenerationProposal {
  const root = closed(output, ['course', 'lessons', 'rationale'], 'output');
  const courseRaw =
    root.course === undefined
      ? {}
      : closed(root.course, ['summary', 'subject', 'objectives'], 'course');
  const course: CourseGenerationProposal['course'] = {};
  if (courseRaw.summary !== undefined)
    course.summary = str(courseRaw.summary, 'course.summary', 20_000);
  if (courseRaw.subject !== undefined)
    course.subject = str(courseRaw.subject, 'course.subject', 200);
  if (courseRaw.objectives !== undefined) {
    if (
      !Array.isArray(courseRaw.objectives) ||
      courseRaw.objectives.length < 1 ||
      courseRaw.objectives.length > 50
    )
      throw new CourseGenerationOutputError('course.objectives');
    course.objectives = courseRaw.objectives.map((o, i) =>
      str(o, `course.objectives.${i}`, 1000),
    );
  }
  const lessonsRaw = root.lessons ?? [];
  if (!Array.isArray(lessonsRaw) || lessonsRaw.length > 50)
    throw new CourseGenerationOutputError('lessons');
  const seen = new Set<string>();
  const lessons = lessonsRaw.map((raw, i): CourseGenerationProposalLesson => {
    const path = `lessons.${i}`;
    const l = closed(
      raw,
      [
        'lessonKey',
        'sectionKey',
        'sectionTitle',
        'title',
        'body',
        'estimatedMinutes',
        'difficulty',
      ],
      path,
    );
    const lesson: CourseGenerationProposalLesson = {};
    if (l.lessonKey !== undefined) {
      if (
        typeof l.lessonKey !== 'string' ||
        !KEY.test(l.lessonKey) ||
        !existingLessonKeys.has(l.lessonKey) ||
        seen.has(l.lessonKey)
      )
        throw new CourseGenerationOutputError(`${path}.lessonKey`);
      seen.add(l.lessonKey);
      lesson.lessonKey = l.lessonKey;
      if (l.sectionKey !== undefined || l.sectionTitle !== undefined)
        throw new CourseGenerationOutputError(`${path}.sectionKey`);
    } else {
      if (typeof l.sectionKey !== 'string' || !KEY.test(l.sectionKey))
        throw new CourseGenerationOutputError(`${path}.sectionKey`);
      lesson.sectionKey = l.sectionKey;
      if (l.sectionTitle !== undefined)
        lesson.sectionTitle = str(l.sectionTitle, `${path}.sectionTitle`, 300);
      if (l.title === undefined)
        throw new CourseGenerationOutputError(`${path}.title`);
    }
    if (l.title !== undefined)
      lesson.title = str(l.title, `${path}.title`, 300);
    if (l.body !== undefined)
      lesson.body = str(l.body, `${path}.body`, 100_000);
    if (l.estimatedMinutes !== undefined)
      lesson.estimatedMinutes = int(
        l.estimatedMinutes,
        `${path}.estimatedMinutes`,
        1440,
      );
    if (l.difficulty !== undefined)
      lesson.difficulty = int(l.difficulty, `${path}.difficulty`, 10);
    if (lesson.lessonKey && Object.keys(lesson).length === 1)
      throw new CourseGenerationOutputError(path);
    return lesson;
  });
  const rationale =
    root.rationale === undefined ? '' : str(root.rationale, 'rationale', 4000);
  return { course, lessons, rationale };
}

/** Field paths a proposal can decide, and how to read the current value. */
export interface ProposalFieldPlan {
  field: string;
  status: CourseProposalFieldStatus;
  supplied: unknown;
  proposed: unknown;
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function classify(
  supplied: unknown,
  proposed: unknown,
): CourseProposalFieldStatus {
  if (same(supplied, proposed)) return 'unchanged';
  return isEmpty(supplied) ? 'filled' : 'conflict';
}

/** Per-field comparison of a proposal against the supplied base revision. */
export function planProposal(
  base: CourseRevisionView,
  proposal: CourseGenerationProposal,
): ProposalFieldPlan[] {
  const plan: ProposalFieldPlan[] = [];
  for (const key of ['summary', 'subject', 'objectives'] as const) {
    const proposed = proposal.course[key];
    if (proposed === undefined) continue;
    const supplied = base[key];
    plan.push({
      field: `course.${key}`,
      status: classify(supplied, proposed),
      supplied: isEmpty(supplied) ? null : supplied,
      proposed,
    });
  }
  const lessons = new Map(
    base.sections.flatMap((s) => s.lessons).map((l) => [l.lessonKey, l]),
  );
  let added = 0;
  for (const lesson of proposal.lessons) {
    if (lesson.lessonKey) {
      const current = lessons.get(lesson.lessonKey);
      if (!current) continue;
      for (const key of [
        'title',
        'body',
        'estimatedMinutes',
        'difficulty',
      ] as const) {
        const proposed = lesson[key];
        if (proposed === undefined) continue;
        const supplied = current[key];
        plan.push({
          field: `lesson:${lesson.lessonKey}.${key}`,
          status: classify(supplied, proposed),
          supplied: isEmpty(supplied) ? null : supplied,
          proposed,
        });
      }
    } else {
      plan.push({
        field: `new-lesson:${added++}`,
        status: 'added',
        supplied: null,
        proposed: lesson,
      });
    }
  }
  return plan;
}

/** Stable key for a generated lesson, so a replayed job reproduces the same row. */
export const generatedLessonKey = (jobId: string, index: number) =>
  `g-${groupSharingDigest(JSON.stringify([jobId, index])).slice(0, 32)}`;

type LessonField = 'title' | 'body' | 'estimatedMinutes' | 'difficulty';

/** Rebuilds a draft input from a stored revision, preserving materials and questions. */
export function draftFromRevision(view: CourseRevisionView): CourseDraftInput {
  return {
    title: view.title,
    summary: view.summary,
    subject: view.subject,
    theme: view.theme,
    levelMin: view.levelMin,
    levelMax: view.levelMax,
    objectives: [...view.objectives],
    provenance: view.provenance,
    fieldProvenance: { ...view.fieldProvenance },
    sections: view.sections.map((section) => ({
      sectionKey: section.sectionKey,
      title: section.title,
      lessons: section.lessons.map(
        (l): CourseLessonInput => ({
          lessonKey: l.lessonKey,
          title: l.title,
          body: l.body,
          lessonType: l.lessonType,
          completionRule: l.completionRule,
          estimatedMinutes: l.estimatedMinutes,
          difficulty: l.difficulty,
          modality: l.modality,
          externalRef: l.externalRef,
          externalUrl: l.externalUrl,
          licenseKind: l.licenseKind,
          provenance: l.provenance,
          fieldProvenance: { ...l.fieldProvenance },
          materials: l.materials.map((m) => ({
            assetId: m.assetId,
            relationship: m.relationship,
            licenseKind: m.licenseKind,
          })),
          questions: l.questions,
          layoutParams: l.layoutParams,
        }),
      ),
    })),
  };
}

/**
 * Applies the selected plan entries to a draft built from `view`. Returns
 * the fields that no longer apply (for example a deleted lesson).
 */
export function applyProposalFields(
  draft: CourseDraftInput,
  entries: ReadonlyArray<ProposalFieldPlan>,
  options: { jobId: string },
): { missing: string[] } {
  const missing: string[] = [];
  for (const entry of entries) {
    const [head, rest] = [entry.field.split('.', 1)[0], entry.field];
    if (head === 'course') {
      const key = entry.field.slice('course.'.length) as
        | 'summary'
        | 'subject'
        | 'objectives';
      (draft as unknown as Record<string, unknown>)[key] = entry.proposed;
      draft.fieldProvenance = { ...draft.fieldProvenance, [key]: 'generated' };
    } else if (rest.startsWith('lesson:')) {
      const dot = rest.lastIndexOf('.');
      const lessonKey = rest.slice('lesson:'.length, dot);
      const key = rest.slice(dot + 1) as LessonField;
      const lesson = draft.sections
        .flatMap((s) => s.lessons)
        .find((l) => l.lessonKey === lessonKey);
      if (!lesson) {
        missing.push(entry.field);
        continue;
      }
      (lesson as unknown as Record<string, unknown>)[key] = entry.proposed;
      lesson.provenance = 'edited';
      lesson.fieldProvenance = {
        ...lesson.fieldProvenance,
        [key]: 'generated',
      };
    } else if (rest.startsWith('new-lesson:')) {
      const index = Number(rest.slice('new-lesson:'.length));
      const proposed = entry.proposed as CourseGenerationProposalLesson;
      const sectionKey = proposed.sectionKey as string;
      let section = draft.sections.find((s) => s.sectionKey === sectionKey);
      if (!section) {
        section = {
          sectionKey,
          title: proposed.sectionTitle ?? sectionKey,
          lessons: [],
        };
        draft.sections.push(section);
      }
      const generated = {
        title: 'generated',
        body: 'generated',
        estimatedMinutes: 'generated',
        difficulty: 'generated',
      } as const;
      section.lessons.push({
        lessonKey: generatedLessonKey(options.jobId, index),
        title: proposed.title as string,
        ...(proposed.body === undefined ? {} : { body: proposed.body }),
        ...(proposed.estimatedMinutes === undefined
          ? {}
          : { estimatedMinutes: proposed.estimatedMinutes }),
        ...(proposed.difficulty === undefined
          ? {}
          : { difficulty: proposed.difficulty }),
        provenance: 'generated',
        fieldProvenance: Object.fromEntries(
          Object.keys(generated)
            .filter(
              (k) =>
                k === 'title' ||
                (proposed as Record<string, unknown>)[k] !== undefined,
            )
            .map((k) => [k, 'generated' as const]),
        ),
      });
    }
  }
  return { missing };
}

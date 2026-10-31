import { withPrivateAssetAccess } from '@happyvertical/smrt-assets';
import {
  isEmbeddedDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CourseLicenseKind, CourseModality } from './catalog.js';
import {
  AuthoredCourseCollection,
  CourseSectionCollection,
  ExerciseCollection,
  LessonAssetCollection,
  ReadingCollection,
  VideoCollection,
  WorksheetCollection,
} from './collections.js';
import {
  type AutoUpgradeSkipView,
  COURSE_PROVENANCES,
  type CourseArchiveDecisionView,
  CourseArchivedError,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  type CourseAuthoringOperation,
  CourseAuthoringValidationError,
  type CourseAuthorizationDecision,
  type CourseDelegationVerifier,
  CourseDiscardedError,
  CourseDiscardRefusedError,
  type CourseDraftInput,
  type CourseHeadView,
  type CourseLessonInput,
  type CourseLessonRevisionView,
  type CourseLessonType,
  type CourseLifecycleState,
  CourseMaterialCopyError,
  type CourseMaterialCopyPort,
  type CourseMaterialView,
  CourseNotFoundError,
  type CoursePage,
  type CoursePageRequest,
  type CourseProvenance,
  type CourseReferenceGuard,
  type CourseReleaseView,
  CourseRequestKeyConflictError,
  CourseRevisionAlreadyReleasedError,
  type CourseRevisionView,
  CourseStaleHeadError,
  type CourseStateView,
  type CourseSummaryView,
  type CourseUpgradeChoiceView,
  DEFAULT_PAGE_SIZE,
  EnrollmentPinConflictError,
  type EnrollmentPinKind,
  type EnrollmentPinView,
  type EnrollmentReleaseView,
  MAX_PAGE_SIZE,
  type ReleaseReviewGate,
  ReviewGateRequiredError,
  ReviewNotCurrentError,
  type SetAutoUpgradeResult,
} from './course-authoring-contracts.js';
import {
  AUTHORED_IDENTITY_SOURCE_KEY,
  AUTHORED_RELEASE_SOURCE_KEY,
  isAuthoredReleaseGroupShareable,
  isGroupShareableLicense,
  mostRestrictiveLicense,
} from './course-authoring-licence.js';
import {
  CourseArchiveDecisionCollection,
  CourseDiscardTombstoneCollection,
  CourseDraftHeadCollection,
  type CourseRelease,
  CourseReleaseCollection,
  type CourseRevision,
  CourseRevisionCollection,
  type CourseUpgradeChoice,
  CourseUpgradeChoiceCollection,
  EnrollmentAutoUpgradeSkipCollection,
  type EnrollmentReleasePin,
  EnrollmentReleasePinCollection,
  type LessonRevision,
  LessonRevisionCollection,
  ReleasedLessonCollection,
} from './course-authoring-models.js';
import { delegationRecordFields, readDelegation } from './course-delegation.js';
import { resolveEnrollmentLessons } from './course-release-scope.js';
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  type LessonLayoutParams,
  type LessonQuestionRefInput,
  QuestionReferenceError,
} from './question-contracts.js';

const NAMESPACE = 'smrt.education.course-authoring.v1';
const KEY_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;
const LESSON_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_SECTIONS = 100;
const MAX_LESSONS = 1000;
const MAX_TEXT = 200_000;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

/** Deterministic UUID-shaped id; the same inputs always yield the same row id. */
async function derivedId(...parts: string[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([NAMESPACE, ...parts])),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function requireKey(value: unknown, what = 'request key'): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value))
    throw new CourseAuthoringValidationError(`Invalid ${what}`);
  return value;
}
function text(value: unknown, what: string, max: number, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required)
      throw new CourseAuthoringValidationError(`${what} is required`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max)
    throw new CourseAuthoringValidationError(`Invalid ${what}`);
  if (required && !value.trim())
    throw new CourseAuthoringValidationError(`${what} is required`);
  return value;
}
function provenance(value: unknown, fallback: CourseProvenance) {
  const result = value === undefined ? fallback : value;
  if (!COURSE_PROVENANCES.includes(result as CourseProvenance))
    throw new CourseAuthoringValidationError('Invalid provenance');
  return result as CourseProvenance;
}
function fieldProvenance(value: unknown): Record<string, CourseProvenance> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CourseAuthoringValidationError('Invalid field provenance');
  const result: Record<string, CourseProvenance> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key.length > 100)
      throw new CourseAuthoringValidationError('Invalid field provenance');
    result[key] = provenance(v, 'supplied');
  }
  return result;
}
function nonNegativeInt(value: unknown, what: string): number {
  const result = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(result) || (result as number) < 0)
    throw new CourseAuthoringValidationError(`Invalid ${what}`);
  return result as number;
}
const bool = (value: unknown, what: string): boolean => {
  if (typeof value !== 'boolean')
    throw new CourseAuthoringValidationError(`Invalid ${what}`);
  return value;
};
const iso = (date: Date | string) => new Date(date).toISOString();
const optional = (value: string | null | undefined) => value || null;

type Row = Record<string, unknown>;
type Tx = DatabaseInterface;

const SKIP_REASON = 'not-authorized';
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const SKIP_CODE_PATTERN = /^[a-z0-9._-]{1,64}$/;

/**
 * Normalizes an authorizer answer. Only `allowed === true` allows. Reason and
 * code are host-chosen labels: strip control characters, bound them and drop
 * anything invalid, so a skip row can never carry free-form or unbounded text.
 */
function readDecision(result: unknown): {
  allowed: boolean;
  reason: string;
  code: string;
} {
  if (typeof result === 'boolean')
    return { allowed: result, reason: SKIP_REASON, code: '' };
  if (!result || typeof result !== 'object')
    return { allowed: false, reason: SKIP_REASON, code: '' };
  const decision = result as CourseAuthorizationDecision;
  const reason =
    typeof decision.reason === 'string'
      ? decision.reason.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, 200)
      : '';
  return {
    allowed: decision.allowed === true,
    reason: reason || SKIP_REASON,
    code:
      typeof decision.code === 'string' && SKIP_CODE_PATTERN.test(decision.code)
        ? decision.code
        : '',
  };
}

function pageLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new CourseAuthoringValidationError('Invalid page limit');
  return Math.min(value as number, MAX_PAGE_SIZE);
}
type PageKey = readonly [number, string];
const compareKeys = (a: PageKey, b: PageKey) =>
  a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
function encodeCursor(key: PageKey): string {
  return btoa(JSON.stringify(key))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function decodeCursor(cursor: unknown): PageKey | null {
  if (cursor === undefined) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > 400) throw new Error();
    const parsed = JSON.parse(
      atob(cursor.replace(/-/g, '+').replace(/_/g, '/')),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isFinite(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      parsed[1].length <= 200
    )
      return [parsed[0], parsed[1]];
  } catch {
    // fall through
  }
  throw new CourseAuthoringValidationError('Invalid page cursor');
}
/** Total order by (key, id), keyset cursor: stable under concurrent appends. */
function paginate<T>(
  rows: readonly T[],
  keyOf: (row: T) => PageKey,
  request: CoursePageRequest,
): { rows: T[]; nextCursor: string | null } {
  const limit = pageLimit(request.limit);
  const after = decodeCursor(request.cursor);
  const sorted = rows
    .map((row) => ({ row, key: keyOf(row) }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .filter((entry) => !after || compareKeys(entry.key, after) > 0);
  const slice = sorted.slice(0, limit);
  return {
    rows: slice.map((entry) => entry.row),
    nextCursor:
      sorted.length > limit ? encodeCursor(slice[slice.length - 1].key) : null,
  };
}
/** The one lifecycle rule: discarded, else archived, else released, else draft. */
function deriveState(
  discarded: boolean,
  latestArchiveAction: string | undefined,
  releaseCount: number,
): CourseLifecycleState {
  if (discarded) return 'discarded';
  if (latestArchiveAction === 'archive') return 'archived';
  return releaseCount ? 'released' : 'draft';
}
const millis = (value: unknown) => new Date(value as string | Date).getTime();

/** Everything a retried save must reproduce, minus the actor. */
interface PreparedLesson {
  lessonKey: string;
  fields: {
    title: string;
    body: string;
    lessonType: CourseLessonType;
    completionRule: string;
    estimatedMinutes: number;
    difficulty: number;
    modality: CourseModality;
    externalRef: string;
    externalUrl: string;
    licenseKind: CourseLicenseKind;
    provenance: CourseProvenance;
    fieldProvenance: Record<string, CourseProvenance>;
  };
  materials: Array<{
    source: { kind: string; ref: string } | null;
    assetId: string | null;
    relationship: string;
    licenseKind: CourseLicenseKind;
    /** True only when the author restated a licence; a default never loosens a reused asset. */
    licenseStated: boolean;
  }>;
  questions: LessonQuestionRefInput[];
  layoutParams: LessonLayoutParams;
}
interface PreparedDraft {
  title: string;
  summary: string;
  subject: string;
  theme: string;
  levelMin: number;
  levelMax: number;
  objectives: string[];
  provenance: CourseProvenance;
  fieldProvenance: Record<string, CourseProvenance>;
  sections: Array<{
    sectionKey: string;
    title: string;
    lessons: PreparedLesson[];
  }>;
}

const LICENSE_KINDS: CourseLicenseKind[] = [
  'own-work',
  'open-license',
  'personal-use-copy',
  'licensed-for-sharing',
];
function license(
  value: unknown,
  fallback: CourseLicenseKind,
): CourseLicenseKind {
  const result = value === undefined ? fallback : value;
  if (!LICENSE_KINDS.includes(result as CourseLicenseKind))
    throw new CourseAuthoringValidationError('Invalid licence kind');
  return result as CourseLicenseKind;
}

const REF_KEYS = ['questionRevisionId', 'section', 'column', 'anchor'];
function prepareQuestionRefs(value: unknown): LessonQuestionRefInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500)
    throw new CourseAuthoringValidationError('Invalid lesson questions');
  const seen = new Set<string>();
  return value.map((ref): LessonQuestionRefInput => {
    if (
      !ref ||
      typeof ref !== 'object' ||
      Object.keys(ref).some((k) => !REF_KEYS.includes(k)) ||
      typeof ref.questionRevisionId !== 'string' ||
      !ref.questionRevisionId ||
      ref.questionRevisionId.length > 200 ||
      seen.has(ref.questionRevisionId) ||
      (ref.section !== undefined &&
        (typeof ref.section !== 'string' ||
          !LESSON_KEY_PATTERN.test(ref.section))) ||
      (ref.column !== undefined &&
        (!Number.isSafeInteger(ref.column) ||
          ref.column < 1 ||
          ref.column > 12))
    )
      throw new CourseAuthoringValidationError('Invalid lesson question');
    seen.add(ref.questionRevisionId);
    const anchor = ref.anchor;
    if (anchor !== undefined) {
      const rect = anchor?.rect;
      if (
        !anchor ||
        typeof anchor !== 'object' ||
        Object.keys(anchor).some(
          (k) => !['assetId', 'page', 'rect'].includes(k),
        ) ||
        (anchor.assetId !== undefined &&
          (typeof anchor.assetId !== 'string' ||
            !anchor.assetId ||
            anchor.assetId.length > 200)) ||
        (anchor.page !== undefined &&
          (!Number.isSafeInteger(anchor.page) || anchor.page < 1)) ||
        (rect !== undefined &&
          (!Array.isArray(rect) ||
            rect.length !== 4 ||
            rect.some((n) => !Number.isFinite(n) || n < 0 || n > 1)))
      )
        throw new CourseAuthoringValidationError('Invalid question anchor');
    }
    return {
      questionRevisionId: ref.questionRevisionId,
      ...(ref.section !== undefined ? { section: ref.section } : {}),
      ...(ref.column !== undefined ? { column: ref.column } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
    };
  });
}
function prepareLayoutParams(value: unknown): LessonLayoutParams {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CourseAuthoringValidationError('Invalid layout params');
  const entries = Object.entries(value);
  if (
    entries.length > 20 ||
    entries.some(
      ([k, v]) =>
        k.length > 60 ||
        !(
          typeof v === 'boolean' ||
          (typeof v === 'number' && Number.isFinite(v)) ||
          (typeof v === 'string' && v.length <= 200)
        ),
    )
  )
    throw new CourseAuthoringValidationError('Invalid layout params');
  return Object.fromEntries(
    entries.sort(([a], [b]) => a.localeCompare(b)),
  ) as LessonLayoutParams;
}

function prepareDraft(
  input: CourseDraftInput,
  requestKey: string,
  courseId: string,
): PreparedDraft {
  if (!input || typeof input !== 'object' || !Array.isArray(input.sections))
    throw new CourseAuthoringValidationError('Invalid draft');
  if (input.sections.length > MAX_SECTIONS)
    throw new CourseAuthoringValidationError('Too many sections');
  const draftProvenance = provenance(input.provenance, 'supplied');
  const levelMin = nonNegativeInt(input.levelMin, 'level');
  const levelMax = nonNegativeInt(input.levelMax ?? levelMin, 'level');
  if (levelMax < levelMin)
    throw new CourseAuthoringValidationError('Invalid level range');
  if (
    input.objectives !== undefined &&
    (!Array.isArray(input.objectives) ||
      input.objectives.length > 200 ||
      input.objectives.some(
        (o) => typeof o !== 'string' || !o.trim() || o.length > 1000,
      ))
  )
    throw new CourseAuthoringValidationError('Invalid objectives');
  const sectionKeys = new Set<string>();
  const lessonKeys = new Set<string>();
  let lessonCount = 0;
  const sections = input.sections.map((section, sectionIndex) => {
    const sectionKey = text(section?.sectionKey, 'section key', 120, true);
    if (!LESSON_KEY_PATTERN.test(sectionKey) || sectionKeys.has(sectionKey))
      throw new CourseAuthoringValidationError(
        'Invalid or duplicate section key',
      );
    sectionKeys.add(sectionKey);
    if (!Array.isArray(section.lessons))
      throw new CourseAuthoringValidationError('Invalid section lessons');
    const lessons = section.lessons.map(
      (lesson, lessonIndex): PreparedLesson => {
        if (++lessonCount > MAX_LESSONS)
          throw new CourseAuthoringValidationError('Too many lessons');
        const lessonKey =
          (lesson as CourseLessonInput).lessonKey ??
          `l-${groupSharingDigest(canonical([courseId, requestKey, sectionIndex, lessonIndex])).slice(0, 32)}`;
        if (
          typeof lessonKey !== 'string' ||
          !LESSON_KEY_PATTERN.test(lessonKey) ||
          lessonKeys.has(lessonKey)
        )
          throw new CourseAuthoringValidationError(
            'Invalid or duplicate lesson key',
          );
        lessonKeys.add(lessonKey);
        const lessonType = (lesson.lessonType ?? 'reading') as CourseLessonType;
        if (!['reading', 'video', 'worksheet', 'exercise'].includes(lessonType))
          throw new CourseAuthoringValidationError('Invalid lesson type');
        const completionRule =
          lesson.completionRule ??
          (lessonType === 'worksheet' ? 'submit' : 'attest');
        if (!['attest', 'submit', 'score', 'external'].includes(completionRule))
          throw new CourseAuthoringValidationError('Invalid completion rule');
        const modality = lesson.modality ?? 'online';
        if (
          !['online', 'printable', 'kit', 'video', 'game', 'mixed'].includes(
            modality,
          )
        )
          throw new CourseAuthoringValidationError('Invalid modality');
        const difficulty = lesson.difficulty ?? 0;
        if (!Number.isFinite(difficulty))
          throw new CourseAuthoringValidationError('Invalid difficulty');
        const materials = (lesson.materials ?? []).map((m) => {
          if (
            !m ||
            (m.source === undefined) === (m.assetId === undefined) ||
            !['printable', 'answer-key', 'video', 'attachment'].includes(
              m.relationship,
            )
          )
            throw new CourseAuthoringValidationError('Invalid material');
          if (m.source) {
            text(m.source.kind, 'material source kind', 100, true);
            text(m.source.ref, 'material source ref', 1000, true);
          } else text(m.assetId, 'material asset', 200, true);
          return {
            source: m.source
              ? { kind: m.source.kind, ref: m.source.ref }
              : null,
            assetId: m.assetId ?? null,
            relationship: m.relationship,
            // An uploaded original is treated as private family material unless
            // the author states a different licence.
            licenseKind: license(
              m.licenseKind,
              m.source ? 'personal-use-copy' : 'own-work',
            ),
            licenseStated: m.licenseKind !== undefined,
          };
        });
        return {
          lessonKey,
          questions: prepareQuestionRefs(lesson.questions),
          layoutParams: prepareLayoutParams(lesson.layoutParams),
          fields: {
            title: text(lesson.title, 'lesson title', 300, true),
            body: text(lesson.body, 'lesson body', MAX_TEXT),
            lessonType,
            completionRule,
            estimatedMinutes: nonNegativeInt(
              lesson.estimatedMinutes,
              'estimated minutes',
            ),
            difficulty,
            modality,
            externalRef: text(lesson.externalRef, 'external ref', 500),
            externalUrl: text(lesson.externalUrl, 'external url', 2000),
            licenseKind: license(lesson.licenseKind, 'own-work'),
            provenance: provenance(lesson.provenance, draftProvenance),
            fieldProvenance: fieldProvenance(lesson.fieldProvenance),
          },
          materials,
        };
      },
    );
    return {
      sectionKey,
      title: text(section.title, 'section title', 300, true),
      lessons,
    };
  });
  return {
    title: text(input.title, 'title', 300, true),
    summary: text(input.summary, 'summary', MAX_TEXT),
    subject: text(input.subject, 'subject', 200),
    theme: text(input.theme, 'theme', 200),
    levelMin,
    levelMax,
    objectives: [...(input.objectives ?? [])],
    provenance: draftProvenance,
    fieldProvenance: fieldProvenance(input.fieldProvenance),
    sections,
  };
}

export interface CourseAuthoringServiceOptions {
  /** Supplied by the review feature; without it release always fails closed. */
  releaseReviewGate?: ReleaseReviewGate;
  /** Reports review/variant rows that must block discarding a draft. */
  referenceGuard?: CourseReferenceGuard;
  /** Copies uploaded originals to education-owned assets. */
  materialCopy?: CourseMaterialCopyPort;
  /**
   * Required for any delegated (agent) request: without it delegation fields
   * are refused. Runs on the transaction executor before the authorizer.
   */
  verifyDelegation?: CourseDelegationVerifier;
}

/**
 * Actor-bound authoring of revisioned courses. All writes are one transaction;
 * every authorizer call receives that transaction's executor.
 */
export class CourseAuthoringService {
  constructor(
    private readonly db: DatabaseInterface,
    private readonly authorizer: CourseAuthoringAuthorizer,
    private readonly options: CourseAuthoringServiceOptions = {},
  ) {}

  protected run<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    return withEmbeddedWriteTransaction(
      this.db,
      isEmbeddedDatabase(this.db),
      operation,
    );
  }

  protected async authorize(
    tx: Tx,
    actor: CourseAuthoringActor,
    action: CourseAuthoringAction,
    operation: CourseAuthoringOperation,
    extra: {
      courseId?: string;
      enrollmentId?: string;
      learnerId?: string;
      releaseId?: string;
      releaseCourseId?: string;
    } = {},
  ): Promise<void> {
    const context = getCurrentTenant();
    if (
      !context ||
      context.superAdminBypass ||
      !actor?.tenantId ||
      !actor.actorUserId ||
      context.tenantId !== actor.tenantId ||
      context.userId !== actor.actorUserId
    )
      throw new CourseAuthoringAuthorizationError();
    const delegation = readDelegation(actor);
    const members = [actor.actorUserId];
    if (delegation) members.push(delegation.delegatingGuardianUserId);
    for (const userId of members) {
      if (
        !(await tx.get('memberships', {
          tenant_id: actor.tenantId,
          user_id: userId,
          status: 'active',
        })) ||
        !(await tx.get('users', { id: userId, status: 'active' }))
      )
        throw new CourseAuthoringAuthorizationError();
    }
    if (
      delegation &&
      !(await this.delegationVerified(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        ...delegation,
        action,
        operation,
        ...extra,
      }))
    )
      throw new CourseAuthoringAuthorizationError();
    const allowed = await this.authorizer({
      tenantId: actor.tenantId,
      actorUserId: actor.actorUserId,
      ...(delegation ?? {}),
      ...extra,
      action,
      operation,
      executor: tx,
    });
    if (readDecision(allowed).allowed !== true)
      throw new CourseAuthoringAuthorizationError();
  }

  /**
   * Fail closed: no port, a denial or a throw all mean the delegation is not
   * verified. The decision carries the verifier's sanitized `{reason, code}` only
   * for an object refusal; a boolean, a throw or a missing port is generic.
   */
  private async delegationDecision(
    executor: DatabaseInterface,
    request: Parameters<CourseDelegationVerifier>[1],
  ): Promise<{ allowed: boolean; reason: string; code: string }> {
    const verify = this.options.verifyDelegation;
    if (typeof verify !== 'function') return readDecision(false);
    try {
      return readDecision(await verify(executor, request));
    } catch {
      return readDecision(false);
    }
  }

  private async delegationVerified(
    executor: DatabaseInterface,
    request: Parameters<CourseDelegationVerifier>[1],
  ): Promise<boolean> {
    return (await this.delegationDecision(executor, request)).allowed === true;
  }

  protected async identityRow(tx: Tx, tenantId: string, courseId: string) {
    if (typeof courseId !== 'string' || !courseId)
      throw new CourseNotFoundError();
    const row = await tx.get('courses', {
      id: courseId,
      tenant_id: tenantId,
      source_key: AUTHORED_IDENTITY_SOURCE_KEY,
    });
    if (!row) throw new CourseNotFoundError();
    return row as Row;
  }

  protected async state(
    tx: Tx,
    tenantId: string,
    courseId: string,
  ): Promise<CourseLifecycleState> {
    const tombstone = await tx.get('course_discard_tombstones', {
      tenant_id: tenantId,
      course_id: courseId,
    });
    if (tombstone) return 'discarded';
    const decisions = await this.archiveDecisions(tx, tenantId, courseId);
    const releases = await tx.list('course_releases', {
      tenant_id: tenantId,
      course_id: courseId,
    });
    return deriveState(false, decisions.at(-1)?.action, releases.length);
  }

  private async archiveDecisions(tx: Tx, tenantId: string, courseId: string) {
    return (
      await (
        await CourseArchiveDecisionCollection.create({ db: tx })
      ).list({
        where: { tenantId, courseId },
        limit: 100000,
      })
    ).sort((a, b) => a.sequence - b.sequence);
  }

  protected async lockHead(tx: Tx, tenantId: string, courseId: string) {
    await tx.query(
      'UPDATE course_draft_heads SET id = id WHERE course_id = ? AND tenant_id = ?',
      [courseId, tenantId],
    );
  }

  protected async writableDraft(tx: Tx, tenantId: string, courseId: string) {
    await this.identityRow(tx, tenantId, courseId);
    if ((await this.state(tx, tenantId, courseId)) === 'discarded')
      throw new CourseDiscardedError();
  }

  // -- creation and drafts -------------------------------------------------

  /** Creates the stable course identity, its first (empty) revision and draft head. */
  async createCourse(
    request: CourseAuthoringActor & {
      requestKey: string;
      title: string;
      summary?: string;
      subject?: string;
      theme?: string;
      levelMin?: number;
      levelMax?: number;
      objectives?: string[];
    },
  ): Promise<CourseHeadView> {
    const requestKey = requireKey(request.requestKey);
    const draft = prepareDraft(
      {
        title: request.title,
        summary: request.summary,
        subject: request.subject,
        theme: request.theme,
        levelMin: request.levelMin,
        levelMax: request.levelMax,
        objectives: request.objectives,
        sections: [],
        provenance: 'supplied',
      },
      requestKey,
      '',
    );
    const payloadDigest = groupSharingDigest(
      canonical({ create: draft, delegationId: request.delegationId ?? '' }),
    );
    return this.run(async (tx) => {
      const courseId = await derivedId('course', request.tenantId, requestKey);
      await this.authorize(tx, request, 'education.course.author', 'create', {
        courseId,
      });
      const existing = await tx.get('courses', { id: courseId });
      if (existing) {
        const revision = await tx.get('course_revisions', {
          tenant_id: request.tenantId,
          course_id: courseId,
          request_key: requestKey,
        });
        if (!revision || revision.payload_digest !== payloadDigest)
          throw new CourseRequestKeyConflictError();
        return this.headView(tx, request.tenantId, courseId);
      }
      await (await AuthoredCourseCollection.create({ db: tx })).create({
        id: courseId,
        tenantId: request.tenantId,
        title: draft.title,
        summary: draft.summary,
        subject: draft.subject,
        levelMin: draft.levelMin,
        levelMax: draft.levelMax,
        sourceKey: AUTHORED_IDENTITY_SOURCE_KEY,
        sourceRef: requestKey,
        licenseKind: 'own-work',
        attestedBy: request.actorUserId,
        status: 'draft',
      });
      const revision = await this.appendRevision(tx, request, {
        courseId,
        parent: null,
        sequence: 1,
        requestKey,
        payloadDigest,
        draft,
        sections: [],
        licenseKind: 'own-work',
      });
      await (await CourseDraftHeadCollection.create({ db: tx })).create({
        tenantId: request.tenantId,
        courseId,
        headRevisionId: String(revision.id),
        version: 1,
        updatedByUserId: request.actorUserId,
        updatedAt: new Date(),
        _insertOnly: true,
      });
      return this.headView(tx, request.tenantId, courseId);
    });
  }

  protected async headView(
    tx: Tx,
    tenantId: string,
    courseId: string,
  ): Promise<CourseHeadView> {
    const head = await tx.get('course_draft_heads', {
      tenant_id: tenantId,
      course_id: courseId,
    });
    if (!head) throw new CourseNotFoundError();
    return {
      courseId,
      headRevisionId: String(head.head_revision_id),
      version: Number(head.version),
    };
  }

  private async appendRevision(
    tx: Tx,
    actor: CourseAuthoringActor,
    input: {
      courseId: string;
      parent: string | null;
      sequence: number;
      requestKey: string;
      payloadDigest: string;
      draft: PreparedDraft;
      sections: Array<{
        sectionKey: string;
        title: string;
        lessonRevisionIds: string[];
      }>;
      licenseKind: CourseLicenseKind;
    },
  ): Promise<CourseRevision> {
    const { draft } = input;
    const contentDigest = groupSharingDigest(
      canonical({
        title: draft.title,
        summary: draft.summary,
        subject: draft.subject,
        theme: draft.theme,
        levelMin: draft.levelMin,
        levelMax: draft.levelMax,
        objectives: draft.objectives,
        sections: input.sections,
      }),
    );
    return (await CourseRevisionCollection.create({ db: tx })).create({
      _insertOnly: true,
      tenantId: actor.tenantId,
      courseId: input.courseId,
      parentRevisionId: input.parent,
      sequence: input.sequence,
      authorUserId: actor.actorUserId,
      ...delegationRecordFields(actor),
      provenance: draft.provenance,
      fieldProvenanceJson: JSON.stringify(draft.fieldProvenance),
      title: draft.title,
      summary: draft.summary,
      subject: draft.subject,
      theme: draft.theme,
      levelMin: draft.levelMin,
      levelMax: draft.levelMax,
      objectivesJson: JSON.stringify(draft.objectives),
      sectionsJson: JSON.stringify(input.sections),
      licenseKind: input.licenseKind,
      requestKey: input.requestKey,
      payloadDigest: input.payloadDigest,
      contentDigest,
      recordedAt: new Date(),
    });
  }

  /**
   * Appends a revision and moves the draft head by expected-head compare and
   * swap. A retried request key replays its original result; the same key with a
   * different payload is a typed conflict.
   */
  async saveDraft(
    request: CourseAuthoringActor & {
      courseId: string;
      expectedHeadRevisionId: string;
      requestKey: string;
      draft: CourseDraftInput;
    },
  ): Promise<CourseHeadView & { revisionId: string }> {
    return this.run((tx) => this.saveDraftIn(tx, request));
  }

  /** The save path on a caller-supplied transaction, so composed writes share CAS and authz. */
  protected async saveDraftIn(
    tx: Tx,
    request: CourseAuthoringActor & {
      courseId: string;
      expectedHeadRevisionId: string;
      requestKey: string;
      draft: CourseDraftInput;
    },
  ): Promise<CourseHeadView & { revisionId: string }> {
    const requestKey = requireKey(request.requestKey);
    const expected = requireKey(
      request.expectedHeadRevisionId,
      'expected head',
    );
    const prepared = prepareDraft(request.draft, requestKey, request.courseId);
    const usesGenerated =
      prepared.provenance === 'generated' ||
      Object.values(prepared.fieldProvenance).includes('generated') ||
      prepared.sections.some((s) =>
        s.lessons.some(
          (l) =>
            l.fields.provenance === 'generated' ||
            Object.values(l.fields.fieldProvenance).includes('generated'),
        ),
      );
    const payloadDigest = groupSharingDigest(
      canonical({
        expected,
        courseId: request.courseId,
        draft: prepared,
        delegationId: request.delegationId ?? '',
      }),
    );
    {
      await this.authorize(
        tx,
        request,
        'education.course.author',
        'save-draft',
        {
          courseId: request.courseId,
        },
      );
      if (usesGenerated)
        await this.authorize(
          tx,
          request,
          'education.course.generate',
          'save-draft',
          {
            courseId: request.courseId,
          },
        );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const replay = await tx.get('course_revisions', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
        request_key: requestKey,
      });
      if (replay) {
        if (replay.payload_digest !== payloadDigest)
          throw new CourseRequestKeyConflictError();
        return {
          courseId: request.courseId,
          headRevisionId: String(replay.id),
          revisionId: String(replay.id),
          version: Number(replay.sequence),
        };
      }
      await this.lockHead(tx, request.tenantId, request.courseId);
      const heads = await CourseDraftHeadCollection.create({ db: tx });
      const head = await heads.get(
        { tenantId: request.tenantId, courseId: request.courseId },
        { cache: false },
      );
      if (!head) throw new CourseNotFoundError();
      if (head.headRevisionId !== expected)
        throw new CourseStaleHeadError(head.headRevisionId);
      const parent = (await tx.get('course_revisions', {
        id: head.headRevisionId,
        tenant_id: request.tenantId,
        course_id: request.courseId,
      })) as Row;
      const known = await this.knownMaterials(
        tx,
        request.tenantId,
        request.courseId,
      );
      const previousByKey = await this.revisionLessonIds(
        tx,
        request.tenantId,
        String(parent.sections_json),
      );
      const history = await this.ownLicenceHistory(
        tx,
        request.tenantId,
        request.courseId,
      );
      const lessonRevisions = await LessonRevisionCollection.create({ db: tx });
      const licences: CourseLicenseKind[] = [];
      const sections: Array<{
        sectionKey: string;
        title: string;
        lessonRevisionIds: string[];
      }> = [];
      for (const section of prepared.sections) {
        const ids: string[] = [];
        for (const lesson of section.lessons) {
          const materials: CourseMaterialView[] = [];
          for (const material of lesson.materials)
            materials.push(
              await this.resolveMaterial(
                tx,
                request,
                request.courseId,
                material,
                known,
              ),
            );
          // A lesson's own licence never loosens: it folds every restriction the
          // course ever recorded for this lessonKey or this content, so rename,
          // omitted keys and remove-then-re-add keep it. Materials add to it.
          const ownLicense = mostRestrictiveLicense([
            lesson.fields.licenseKind,
            ...history.for(lesson.lessonKey, lesson.fields),
          ]);
          const licenseKind = mostRestrictiveLicense([
            ownLicense,
            ...materials.map((m) => m.licenseKind),
          ]);
          licences.push(licenseKind);
          // Question content joins the digest only when present, so lessons
          // without questions keep their existing content digests.
          await this.requireQuestionRevisions(
            tx,
            request.tenantId,
            lesson.questions,
          );
          const body = {
            ...lesson.fields,
            licenseKind,
            ...(ownLicense === 'own-work'
              ? {}
              : { ownLicenseKind: ownLicense }),
            materials,
            ...(lesson.questions.length ? { questions: lesson.questions } : {}),
            ...(Object.keys(lesson.layoutParams).length
              ? { layoutParams: lesson.layoutParams }
              : {}),
          };
          const contentDigest = groupSharingDigest(canonical(body));
          const existing = await lessonRevisions.get(
            {
              tenantId: request.tenantId,
              courseId: request.courseId,
              lessonKey: lesson.lessonKey,
              contentDigest,
            },
            { cache: false },
          );
          const row =
            existing ??
            (await lessonRevisions.create({
              _insertOnly: true,
              tenantId: request.tenantId,
              courseId: request.courseId,
              lessonKey: lesson.lessonKey,
              parentRevisionId: previousByKey.get(lesson.lessonKey) ?? null,
              title: lesson.fields.title,
              body: lesson.fields.body,
              lessonType: lesson.fields.lessonType,
              completionRule: lesson.fields.completionRule,
              estimatedMinutes: lesson.fields.estimatedMinutes,
              difficulty: lesson.fields.difficulty,
              modality: lesson.fields.modality,
              externalRef: lesson.fields.externalRef,
              externalUrl: lesson.fields.externalUrl,
              licenseKind,
              ownLicenseKind: ownLicense,
              materialsJson: JSON.stringify(materials),
              questionsJson: JSON.stringify(lesson.questions),
              layoutParamsJson: JSON.stringify(lesson.layoutParams),
              provenance: lesson.fields.provenance,
              fieldProvenanceJson: JSON.stringify(
                lesson.fields.fieldProvenance,
              ),
              authorUserId: request.actorUserId,
              ...delegationRecordFields(request),
              contentDigest,
              recordedAt: new Date(),
            }));
          ids.push(String(row.id));
        }
        sections.push({
          sectionKey: section.sectionKey,
          title: section.title,
          lessonRevisionIds: ids,
        });
      }
      const sequence = Number(parent.sequence) + 1;
      const revision = await this.appendRevision(tx, request, {
        courseId: request.courseId,
        parent: head.headRevisionId,
        sequence,
        requestKey,
        payloadDigest,
        draft: prepared,
        sections,
        licenseKind: mostRestrictiveLicense(licences),
      });
      head.headRevisionId = String(revision.id);
      head.version = sequence;
      head.updatedByUserId = request.actorUserId;
      head.updatedAt = new Date();
      await head.save();
      await this.onDraftRevisionAppended(tx, request, {
        courseId: request.courseId,
        revisionId: String(revision.id),
      });
      return {
        courseId: request.courseId,
        headRevisionId: String(revision.id),
        revisionId: String(revision.id),
        version: sequence,
      };
    }
  }

  /** Extension point run inside the save transaction after the head moved. */
  protected async onDraftRevisionAppended(
    _tx: Tx,
    _actor: CourseAuthoringActor,
    _revision: { courseId: string; revisionId: string },
  ): Promise<void> {}

  private async revisionLessonIds(
    tx: Tx,
    tenantId: string,
    sectionsJson: string,
  ) {
    const result = new Map<string, string>();
    const ids = (
      JSON.parse(sectionsJson) as Array<{ lessonRevisionIds: string[] }>
    ).flatMap((s) => s.lessonRevisionIds);
    for (const id of ids) {
      const row = await tx.get('lesson_revisions', { id, tenant_id: tenantId });
      if (row) result.set(String(row.lesson_key), id);
    }
    return result;
  }

  /**
   * Restricted own licences recorded anywhere in the course history, indexed by
   * lessonKey and by normalized body / title-and-body digest.
   */
  private async ownLicenceHistory(tx: Tx, tenantId: string, courseId: string) {
    const byKey = new Map<string, CourseLicenseKind[]>();
    const byContent = new Map<string, CourseLicenseKind[]>();
    const add = (
      map: Map<string, CourseLicenseKind[]>,
      key: string,
      kind: CourseLicenseKind,
    ) => map.set(key, [...(map.get(key) ?? []), kind]);
    const normalize = (value: string) =>
      value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const contentKeys = (title: string, body: string) => {
      const keys = [
        groupSharingDigest(
          canonical(['tb', normalize(title), normalize(body)]),
        ),
      ];
      if (normalize(body))
        keys.push(groupSharingDigest(canonical(['b', normalize(body)])));
      return keys;
    };
    const rows = await tx.list('lesson_revisions', {
      tenant_id: tenantId,
      course_id: courseId,
    });
    for (const row of rows) {
      const kind = (row.own_license_kind || 'own-work') as CourseLicenseKind;
      if (kind === 'own-work') continue;
      add(byKey, String(row.lesson_key), kind);
      for (const key of contentKeys(String(row.title), String(row.body)))
        add(byContent, key, kind);
    }
    return {
      for: (
        lessonKey: string,
        fields: { title: string; body: string },
      ): CourseLicenseKind[] => [
        ...(byKey.get(lessonKey) ?? []),
        ...contentKeys(fields.title, fields.body).flatMap(
          (key) => byContent.get(key) ?? [],
        ),
      ],
    };
  }

  /** Assets this course already owns through earlier lesson revisions. */
  private async knownMaterials(tx: Tx, tenantId: string, courseId: string) {
    const known = new Map<string, CourseMaterialView>();
    const rows = await tx.list('lesson_revisions', {
      tenant_id: tenantId,
      course_id: courseId,
    });
    // Fold every occurrence so the most restrictive licence ever recorded
    // wins regardless of row order.
    for (const row of rows) {
      for (const m of JSON.parse(
        String(row.materials_json),
      ) as CourseMaterialView[]) {
        const seen = known.get(m.assetId);
        known.set(
          m.assetId,
          seen
            ? {
                ...seen,
                licenseKind: mostRestrictiveLicense([
                  seen.licenseKind,
                  m.licenseKind,
                ]),
              }
            : m,
        );
      }
    }
    return known;
  }

  private async resolveMaterial(
    tx: Tx,
    actor: CourseAuthoringActor,
    courseId: string,
    material: PreparedLesson['materials'][number],
    known: Map<string, CourseMaterialView>,
  ): Promise<CourseMaterialView> {
    if (material.assetId) {
      const prior = known.get(material.assetId);
      if (!prior) throw new CourseMaterialCopyError('Unknown course material');
      return {
        assetId: prior.assetId,
        relationship:
          material.relationship as CourseMaterialView['relationship'],
        // A reused asset never gets looser: an omitted licence is not a statement.
        licenseKind: mostRestrictiveLicense([
          prior.licenseKind,
          ...(material.licenseStated ? [material.licenseKind] : []),
        ]),
        provenance: prior.provenance,
      };
    }
    const port = this.options.materialCopy;
    if (!port || !material.source)
      throw new CourseMaterialCopyError('Material copying is not configured');
    const copied = await port.copy(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.actorUserId,
      courseId,
      source: material.source,
      relationship: material.relationship as CourseMaterialView['relationship'],
    });
    if (
      !copied?.assetId ||
      !(await tx.get('assets', {
        id: copied.assetId,
        tenant_id: actor.tenantId,
      }))
    )
      throw new CourseMaterialCopyError();
    const view: CourseMaterialView = {
      assetId: copied.assetId,
      relationship: material.relationship as CourseMaterialView['relationship'],
      licenseKind: material.licenseKind,
      provenance: {
        source: material.source,
        copiedAt: new Date().toISOString(),
        copiedByUserId: actor.actorUserId,
      },
    };
    known.set(view.assetId, view);
    return view;
  }

  // -- reads ----------------------------------------------------------------

  protected lessonView(row: LessonRevision | Row): CourseLessonRevisionView {
    const r = row as unknown as LessonRevision;
    return {
      id: String(r.id),
      lessonKey: r.lessonKey,
      parentRevisionId: optional(r.parentRevisionId),
      title: r.title,
      body: r.body,
      lessonType: r.lessonType as CourseLessonType,
      completionRule:
        r.completionRule as CourseLessonRevisionView['completionRule'],
      estimatedMinutes: r.estimatedMinutes,
      difficulty: r.difficulty,
      modality: r.modality as CourseModality,
      externalRef: r.externalRef,
      externalUrl: r.externalUrl,
      licenseKind: r.licenseKind,
      provenance: r.provenance as CourseProvenance,
      fieldProvenance: JSON.parse(r.fieldProvenanceJson),
      materials: JSON.parse(r.materialsJson),
      questions: JSON.parse(r.questionsJson || '[]'),
      layoutParams: JSON.parse(r.layoutParamsJson || '{}'),
    };
  }

  /** Lesson question refs must name existing immutable revisions of this tenant. */
  private async requireQuestionRevisions(
    tx: Tx,
    tenantId: string,
    refs: readonly LessonQuestionRefInput[],
  ) {
    const missing: string[] = [];
    for (const ref of refs)
      if (
        !(await tx.get('question_revisions', {
          id: ref.questionRevisionId,
          tenant_id: tenantId,
        }))
      )
        missing.push(ref.questionRevisionId);
    if (missing.length) throw new QuestionReferenceError(missing);
  }

  protected async revisionView(
    tx: Tx,
    tenantId: string,
    revision: CourseRevision,
  ): Promise<CourseRevisionView> {
    const lessons = new Map(
      (
        await (
          await LessonRevisionCollection.create({ db: tx })
        ).list({
          where: { tenantId, courseId: revision.courseId },
          limit: 100000,
        })
      ).map((row) => [String(row.id), row]),
    );
    return {
      id: String(revision.id),
      courseId: revision.courseId,
      parentRevisionId: optional(revision.parentRevisionId),
      sequence: revision.sequence,
      title: revision.title,
      summary: revision.summary,
      subject: revision.subject,
      theme: revision.theme,
      levelMin: revision.levelMin,
      levelMax: revision.levelMax,
      objectives: JSON.parse(revision.objectivesJson),
      licenseKind: revision.licenseKind,
      provenance: revision.provenance as CourseProvenance,
      fieldProvenance: JSON.parse(revision.fieldProvenanceJson),
      authorUserId: revision.authorUserId,
      delegatingGuardianUserId: optional(revision.delegatingGuardianUserId),
      delegationId: optional(revision.delegationId),
      recordedAt: iso(revision.recordedAt),
      sections: (
        JSON.parse(revision.sectionsJson) as Array<{
          sectionKey: string;
          title: string;
          lessonRevisionIds: string[];
        }>
      ).map((section) => ({
        sectionKey: section.sectionKey,
        title: section.title,
        lessons: section.lessonRevisionIds.map((id) => {
          const row = lessons.get(id);
          if (!row)
            throw new Error('Course revision references a missing lesson');
          return this.lessonView(row);
        }),
      })),
    };
  }

  /** Reads a draft revision (the head unless `revisionId` is given), answer keys included. */
  async readDraft(
    request: CourseAuthoringActor & { courseId: string; revisionId?: string },
  ): Promise<{ head: CourseHeadView; revision: CourseRevisionView }> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-draft',
        {
          courseId: request.courseId,
        },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const head = await this.headView(tx, request.tenantId, request.courseId);
      const revision = await (
        await CourseRevisionCollection.create({ db: tx })
      ).get(
        {
          id: request.revisionId ?? head.headRevisionId,
          tenantId: request.tenantId,
          courseId: request.courseId,
        },
        { cache: false },
      );
      if (!revision) throw new CourseNotFoundError();
      return {
        head,
        revision: await this.revisionView(tx, request.tenantId, revision),
      };
    });
  }

  async getCourse(
    request: CourseAuthoringActor & { courseId: string },
  ): Promise<CourseStateView> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-draft',
        {
          courseId: request.courseId,
        },
      );
      return this.courseState(tx, request.tenantId, request.courseId);
    });
  }

  private async courseState(
    tx: Tx,
    tenantId: string,
    courseId: string,
  ): Promise<CourseStateView> {
    const course = await this.identityRow(tx, tenantId, courseId);
    const state = await this.state(tx, tenantId, courseId);
    const head = await tx.get('course_draft_heads', {
      tenant_id: tenantId,
      course_id: courseId,
    });
    const revision = head
      ? await tx.get('course_revisions', {
          id: head.head_revision_id,
          tenant_id: tenantId,
        })
      : null;
    const licenseKind = (revision?.license_kind ??
      'own-work') as CourseLicenseKind;
    const releases = (
      await tx.list('course_releases', {
        tenant_id: tenantId,
        course_id: courseId,
      })
    )
      .map((r) => ({
        id: String(r.id),
        releaseNumber: Number(r.release_number),
        revisionId: String(r.revision_id),
        releaseCourseId: String(r.release_course_id),
      }))
      .sort((a, b) => a.releaseNumber - b.releaseNumber);
    return {
      courseId,
      title: String(course.title),
      state,
      licenseKind,
      groupShareable: isGroupShareableLicense(licenseKind),
      headRevisionId: head ? String(head.head_revision_id) : null,
      releases,
    };
  }

  /**
   * Authored courses of the tenant, oldest first (created time, then id), with
   * state, draft head, latest release and archive state. Discarded courses are
   * excluded unless `includeDiscarded` is true. Needs `read-draft`.
   */
  async listCourses(
    request: CourseAuthoringActor &
      CoursePageRequest & { includeDiscarded?: boolean },
  ): Promise<CoursePage<CourseSummaryView>> {
    pageLimit(request.limit);
    decodeCursor(request.cursor);
    const includeDiscarded =
      request.includeDiscarded === undefined
        ? false
        : bool(request.includeDiscarded, 'includeDiscarded');
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'list-courses',
      );
      const discarded = new Set(
        (
          await tx.list('course_discard_tombstones', {
            tenant_id: request.tenantId,
          })
        ).map((row) => String(row.course_id)),
      );
      const identities = (
        await tx.list('courses', {
          tenant_id: request.tenantId,
          source_key: AUTHORED_IDENTITY_SOURCE_KEY,
        })
      ).filter((row) => includeDiscarded || !discarded.has(String(row.id)));
      const page = paginate(
        identities,
        (row) => [millis(row.created_at), String(row.id)],
        request,
      );
      // One batched read per table for the whole page, never per row.
      const pageIds = page.rows.map((row) => String(row.id));
      const byCourse = <T extends Row>(rows: T[], key: string) => {
        const grouped = new Map<string, T[]>();
        for (const row of rows)
          grouped.set(String(row[key]), [
            ...(grouped.get(String(row[key])) ?? []),
            row,
          ]);
        return grouped;
      };
      const none = pageIds.length === 0;
      const releases = none
        ? []
        : await tx.list('course_releases', {
            tenant_id: request.tenantId,
            'course_id in': pageIds,
          });
      const heads = none
        ? []
        : await tx.list('course_draft_heads', {
            tenant_id: request.tenantId,
            'course_id in': pageIds,
          });
      const revisionIds = heads.map((head) => String(head.head_revision_id));
      const revisions = revisionIds.length
        ? await tx.list('course_revisions', {
            tenant_id: request.tenantId,
            'id in': revisionIds,
          })
        : [];
      const releaseCourseIds = releases.map((r) => String(r.release_course_id));
      const releaseCourses = releaseCourseIds.length
        ? await tx.list('courses', {
            tenant_id: request.tenantId,
            'id in': releaseCourseIds,
          })
        : [];
      const lookup = {
        releases: byCourse(releases, 'course_id'),
        heads: new Map(heads.map((h) => [String(h.course_id), h])),
        revisions: new Map(revisions.map((r) => [String(r.id), r])),
        releaseCourses: new Map(releaseCourses.map((c) => [String(c.id), c])),
      };
      const items: CourseSummaryView[] = [];
      for (const row of page.rows)
        items.push(
          await this.courseSummary(
            tx,
            request.tenantId,
            row as Row,
            discarded.has(String(row.id)),
            lookup,
          ),
        );
      return { items, nextCursor: page.nextCursor };
    });
  }

  private async courseSummary(
    tx: Tx,
    tenantId: string,
    row: Row,
    discarded: boolean,
    lookup: {
      releases: Map<string, Row[]>;
      heads: Map<string, Row>;
      revisions: Map<string, Row>;
      releaseCourses: Map<string, Row>;
    },
  ): Promise<CourseSummaryView> {
    const courseId = String(row.id);
    const decisions = await this.archiveDecisions(tx, tenantId, courseId);
    const releases = [...(lookup.releases.get(courseId) ?? [])];
    const latest = [...releases].sort(
      (a, b) => Number(b.release_number) - Number(a.release_number),
    )[0];
    const decision = decisions.at(-1);
    const head = lookup.heads.get(courseId);
    const revision = head
      ? lookup.revisions.get(String(head.head_revision_id))
      : undefined;
    const state = deriveState(discarded, decision?.action, releases.length);
    // The effective licence is the most restrictive of the head revision and every
    // release's materialized course; a licence recorded once never loosens.
    const licenseKind = mostRestrictiveLicense([
      (revision?.license_kind ?? 'own-work') as CourseLicenseKind,
      ...releases.map(
        (r) =>
          (lookup.releaseCourses.get(String(r.release_course_id))
            ?.license_kind ?? 'own-work') as CourseLicenseKind,
      ),
    ]);
    return {
      courseId,
      title: String(row.title),
      state,
      createdAt: iso(row.created_at as string | Date),
      licenseKind,
      // Nothing is shareable until a release exists; the group-sharing rule then
      // applies to the effective licence (personal-use is never shareable).
      groupShareable:
        releases.length > 0 &&
        isAuthoredReleaseGroupShareable({
          sourceKey: AUTHORED_RELEASE_SOURCE_KEY,
          licenseKind,
        }),
      releaseCount: releases.length,
      head:
        head && revision
          ? {
              revisionId: String(head.head_revision_id),
              sequence: Number(revision.sequence),
              version: Number(head.version),
            }
          : null,
      latestRelease: latest
        ? {
            id: String(latest.id),
            revisionId: String(latest.revision_id),
            releaseNumber: Number(latest.release_number),
            releaseCourseId: String(latest.release_course_id),
            recordedAt: iso(latest.recorded_at as string | Date),
          }
        : null,
      archive: {
        archived: !discarded && decision?.action === 'archive',
        latestDecision: decision
          ? ({
              action: decision.action as 'archive' | 'unarchive',
              sequence: decision.sequence,
              actorUserId: decision.actorUserId,
              delegatingGuardianUserId: optional(
                decision.delegatingGuardianUserId,
              ),
              delegationId: optional(decision.delegationId),
              recordedAt: iso(decision.recordedAt),
            } satisfies CourseArchiveDecisionView)
          : null,
      },
    };
  }

  private choiceView(row: CourseUpgradeChoice): CourseUpgradeChoiceView {
    return {
      id: String(row.id),
      courseId: row.courseId,
      scope: row.enrollmentId ? 'enrollment' : 'course',
      enrollmentId: optional(row.enrollmentId),
      enabled: row.enabled,
      kind: row.enabled ? 'opt-in' : 'opt-out',
      sequence: row.sequence,
      actorUserId: row.actorUserId,
      delegatingGuardianUserId: optional(row.delegatingGuardianUserId),
      delegationId: optional(row.delegationId),
      policyBasis: row.policyBasis,
      recordedAt: iso(row.recordedAt),
    };
  }

  /**
   * Recorded auto-upgrade opt-in/out history of a course, in sequence order:
   * every row (course and enrollment level), or with `enrollmentId` that
   * enrollment's own rows plus the choice that currently governs it.
   * Needs `read-draft` (authoring view); a foreign enrollment is a denial.
   */
  async listUpgradeChoices(
    request: CourseAuthoringActor &
      CoursePageRequest & { courseId: string; enrollmentId?: string },
  ): Promise<
    CoursePage<CourseUpgradeChoiceView> & {
      governing: CourseUpgradeChoiceView | null;
    }
  > {
    pageLimit(request.limit);
    decodeCursor(request.cursor);
    return this.run(async (tx) => {
      const enrollment = request.enrollmentId
        ? await this.enrollmentRow(tx, request.tenantId, request.enrollmentId)
        : null;
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'list-upgrade-choices',
        {
          courseId: request.courseId,
          ...(enrollment
            ? {
                enrollmentId: String(enrollment.id),
                learnerId: String(enrollment.learner_id),
              }
            : {}),
        },
      );
      await this.identityRow(tx, request.tenantId, request.courseId);
      const rows = (
        await (
          await CourseUpgradeChoiceCollection.create({ db: tx })
        ).list({
          where: { tenantId: request.tenantId, courseId: request.courseId },
          limit: 100000,
        })
      ).filter(
        (row) => !enrollment || row.enrollmentId === request.enrollmentId,
      );
      const page = paginate(
        rows,
        (row) => [row.sequence, String(row.id)],
        request,
      );
      const governing = enrollment
        ? await this.governingChoice(
            tx,
            request.tenantId,
            request.courseId,
            String(enrollment.id),
          )
        : null;
      return {
        items: page.rows.map((row) => this.choiceView(row)),
        nextCursor: page.nextCursor,
        governing: governing ? this.choiceView(governing) : null,
      };
    });
  }

  /**
   * Automatic upgrades that were not performed, oldest first, for a course
   * and/or an enrollment (at least one is required). Needs `read-draft`.
   */
  async listAutoUpgradeSkips(
    request: CourseAuthoringActor &
      CoursePageRequest & { courseId?: string; enrollmentId?: string },
  ): Promise<CoursePage<AutoUpgradeSkipView>> {
    pageLimit(request.limit);
    decodeCursor(request.cursor);
    for (const value of [request.courseId, request.enrollmentId])
      if (value !== undefined && (typeof value !== 'string' || !value))
        throw new CourseAuthoringValidationError('Invalid skip filter');
    if (!request.courseId && !request.enrollmentId)
      throw new CourseAuthoringValidationError(
        'A course or an enrollment is required',
      );
    return this.run(async (tx) => {
      const enrollment = request.enrollmentId
        ? await this.enrollmentRow(tx, request.tenantId, request.enrollmentId)
        : null;
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'list-auto-upgrade-skips',
        {
          ...(request.courseId ? { courseId: request.courseId } : {}),
          ...(enrollment
            ? {
                enrollmentId: String(enrollment.id),
                learnerId: String(enrollment.learner_id),
              }
            : {}),
        },
      );
      if (request.courseId)
        await this.identityRow(tx, request.tenantId, request.courseId);
      const rows = await (
        await EnrollmentAutoUpgradeSkipCollection.create({ db: tx })
      ).list({
        where: {
          tenantId: request.tenantId,
          ...(request.courseId ? { courseId: request.courseId } : {}),
          ...(request.enrollmentId
            ? { enrollmentId: request.enrollmentId }
            : {}),
        },
        limit: 100000,
      });
      const page = paginate(
        rows,
        (row) => [millis(row.recordedAt), String(row.id)],
        request,
      );
      return {
        items: page.rows.map(
          (row): AutoUpgradeSkipView => ({
            id: String(row.id),
            enrollmentId: row.enrollmentId,
            learnerId: row.learnerId,
            courseId: row.courseId,
            releaseId: row.releaseId,
            optInScope: row.optInScope as 'course' | 'enrollment',
            optInActorUserId: row.optInActorUserId,
            optInDelegatingGuardianUserId: optional(
              row.optInDelegatingGuardianUserId,
            ),
            optInDelegationId: optional(row.optInDelegationId),
            policyBasis: row.policyBasis,
            reason: row.reason,
            code: row.code,
            recordedAt: iso(row.recordedAt),
          }),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  // -- release --------------------------------------------------------------

  /**
   * Freezes one revision for assignment. Requires a current review of that exact
   * revision from the injected gate; materializes immutable Course, section and
   * Lesson rows for this release only.
   */
  async release(
    request: CourseAuthoringActor & {
      courseId: string;
      revisionId: string;
      requestKey: string;
    },
  ): Promise<CourseReleaseView> {
    const requestKey = requireKey(request.requestKey);
    return this.run(async (tx) => {
      await this.authorize(tx, request, 'education.course.release', 'release', {
        courseId: request.courseId,
      });
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const releases = await CourseReleaseCollection.create({ db: tx });
      const replay = await releases.get(
        {
          tenantId: request.tenantId,
          courseId: request.courseId,
          requestKey,
        },
        { cache: false },
      );
      if (replay) {
        if (
          replay.revisionId !== request.revisionId ||
          replay.delegationId !== (request.delegationId ?? '')
        )
          throw new CourseRequestKeyConflictError();
        return this.releaseView(tx, request.tenantId, replay);
      }
      if (
        (await this.state(tx, request.tenantId, request.courseId)) ===
        'archived'
      )
        throw new CourseArchivedError();
      await this.lockHead(tx, request.tenantId, request.courseId);
      const revision = await (
        await CourseRevisionCollection.create({ db: tx })
      ).get(
        {
          id: request.revisionId,
          tenantId: request.tenantId,
          courseId: request.courseId,
        },
        { cache: false },
      );
      if (!revision) throw new CourseNotFoundError();
      const already = await releases.get(
        {
          tenantId: request.tenantId,
          courseId: request.courseId,
          revisionId: request.revisionId,
        },
        { cache: false },
      );
      if (already)
        throw new CourseRevisionAlreadyReleasedError(String(already.id));
      const gate = this.options.releaseReviewGate;
      if (!gate) throw new ReviewGateRequiredError();
      const review = await gate(tx, {
        tenantId: request.tenantId,
        courseId: request.courseId,
        revisionId: request.revisionId,
      });
      if (review?.current !== true)
        throw new ReviewNotCurrentError(review?.reason);
      const view = await this.revisionView(tx, request.tenantId, revision);
      if (!view.sections.some((s) => s.lessons.length))
        throw new CourseAuthoringValidationError(
          'A release requires at least one lesson',
        );
      const releaseNumber =
        (
          await tx.list('course_releases', {
            tenant_id: request.tenantId,
            course_id: request.courseId,
          })
        ).length + 1;
      const releaseCourseId = await derivedId(
        'release-course',
        request.revisionId,
      );
      const release = await this.materialize(tx, request, {
        view,
        releaseNumber,
        releaseCourseId,
        reviewId: review.reviewId ?? '',
        requestKey,
      });
      await this.autoUpgrade(tx, request.tenantId, request.courseId, release);
      return this.releaseView(tx, request.tenantId, release);
    });
  }

  private async materialize(
    tx: Tx,
    actor: CourseAuthoringActor,
    input: {
      view: CourseRevisionView;
      releaseNumber: number;
      releaseCourseId: string;
      reviewId: string;
      requestKey: string;
    },
  ): Promise<CourseRelease> {
    const { view } = input;
    const lessons = view.sections.flatMap((s) => s.lessons);
    const personal = view.licenseKind === 'personal-use-copy';
    const modalities = new Set(lessons.map((l) => l.modality));
    await (await AuthoredCourseCollection.create({ db: tx })).create({
      id: input.releaseCourseId,
      tenantId: actor.tenantId,
      title: view.title,
      summary: view.summary,
      subject: view.subject,
      levelMin: view.levelMin,
      levelMax: view.levelMax,
      sourceKey: AUTHORED_RELEASE_SOURCE_KEY,
      sourceRef: `${view.courseId}@${input.releaseNumber}`,
      licenseKind: view.licenseKind,
      attestedBy: actor.actorUserId,
      estimatedMinutes: lessons.reduce((n, l) => n + l.estimatedMinutes, 0),
      modality: modalities.size === 1 ? [...modalities][0] : 'mixed',
      // A personal-use course can never be published; the release row is the authority.
      status: personal ? 'draft' : 'published',
    });
    const release = await (
      await CourseReleaseCollection.create({ db: tx })
    ).create({
      _insertOnly: true,
      tenantId: actor.tenantId,
      courseId: view.courseId,
      revisionId: view.id,
      releaseCourseId: input.releaseCourseId,
      releaseNumber: input.releaseNumber,
      reviewId: input.reviewId,
      actorUserId: actor.actorUserId,
      ...delegationRecordFields(actor),
      requestKey: input.requestKey,
      recordedAt: new Date(),
    });
    const sections = await CourseSectionCollection.create({ db: tx });
    const released = await ReleasedLessonCollection.create({ db: tx });
    const links = await LessonAssetCollection.create({ db: tx });
    const byType = {
      reading: await ReadingCollection.create({ db: tx }),
      video: await VideoCollection.create({ db: tx }),
      worksheet: await WorksheetCollection.create({ db: tx }),
      exercise: await ExerciseCollection.create({ db: tx }),
    };
    for (const [sectionIndex, section] of view.sections.entries()) {
      const sectionId = await derivedId('section', view.id, section.sectionKey);
      await sections.create({
        id: sectionId,
        tenantId: actor.tenantId,
        courseId: input.releaseCourseId,
        title: section.title,
        sortOrder: sectionIndex,
      });
      for (const [lessonIndex, lesson] of section.lessons.entries()) {
        const lessonId = await derivedId('lesson', view.id, lesson.lessonKey);
        await byType[lesson.lessonType].create({
          id: lessonId,
          tenantId: actor.tenantId,
          sectionId,
          title: lesson.title,
          body: lesson.body,
          sortOrder: lessonIndex,
          estimatedMinutes: lesson.estimatedMinutes,
          difficulty: lesson.difficulty,
          modality: lesson.modality,
          completionRule: lesson.completionRule,
          // The stable cross-version identity travels with the immutable row.
          externalRef:
            lesson.externalRef || `authored:${lesson.lessonKey}@${lesson.id}`,
          externalUrl: lesson.externalUrl,
        });
        await released.create({
          _insertOnly: true,
          tenantId: actor.tenantId,
          courseId: view.courseId,
          releaseId: String(release.id),
          lessonKey: lesson.lessonKey,
          lessonRevisionId: lesson.id,
          lessonId,
          sectionId,
        });
        for (const [index, material] of lesson.materials.entries()) {
          const link = {
            tenantId: actor.tenantId,
            lessonId,
            assetId: material.assetId,
            relationship: material.relationship,
            sortOrder: index,
          };
          const private_ = personal || material.relationship === 'answer-key';
          try {
            if (!private_) await links.create(link);
            else {
              const asset = await tx.get('assets', {
                id: material.assetId,
                tenant_id: actor.tenantId,
              });
              if (!asset?.owner_profile_id)
                throw new CourseMaterialCopyError(
                  'Private material requires a private owned asset',
                );
              await withPrivateAssetAccess(
                {
                  tenantId: actor.tenantId,
                  actorUserId: actor.actorUserId,
                  ownerProfileId: String(asset.owner_profile_id),
                  assetIds: [material.assetId],
                },
                () => links.create(link),
              );
            }
          } catch (error) {
            if (error instanceof CourseMaterialCopyError) throw error;
            throw new CourseMaterialCopyError(
              'Released material requires an authorized education-owned asset',
            );
          }
        }
      }
    }
    return release;
  }

  private async releaseView(
    tx: Tx,
    tenantId: string,
    release: CourseRelease,
  ): Promise<CourseReleaseView> {
    const lessons = (
      await (
        await ReleasedLessonCollection.create({ db: tx })
      ).list({
        where: { tenantId, releaseId: String(release.id) },
        limit: 100000,
      })
    ).map((l) => ({
      lessonKey: l.lessonKey,
      lessonRevisionId: l.lessonRevisionId,
      lessonId: l.lessonId,
      sectionId: l.sectionId,
    }));
    return {
      id: String(release.id),
      courseId: release.courseId,
      revisionId: release.revisionId,
      releaseNumber: release.releaseNumber,
      releaseCourseId: release.releaseCourseId,
      reviewId: optional(release.reviewId),
      actorUserId: release.actorUserId,
      delegatingGuardianUserId: optional(release.delegatingGuardianUserId),
      delegationId: optional(release.delegationId),
      recordedAt: iso(release.recordedAt),
      lessons: lessons.sort((a, b) => a.lessonKey.localeCompare(b.lessonKey)),
    };
  }

  // -- archive and discard --------------------------------------------------

  /** Reversible; never touches enrollments, progress, submissions, grades or notes. */
  async archive(
    request: CourseAuthoringActor & { courseId: string; requestKey: string },
  ): Promise<CourseStateView> {
    return this.setArchived(request, true);
  }
  async unarchive(
    request: CourseAuthoringActor & { courseId: string; requestKey: string },
  ): Promise<CourseStateView> {
    return this.setArchived(request, false);
  }
  private async setArchived(
    request: CourseAuthoringActor & { courseId: string; requestKey: string },
    archive: boolean,
  ): Promise<CourseStateView> {
    const requestKey = requireKey(request.requestKey);
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.archive',
        archive ? 'archive' : 'unarchive',
        { courseId: request.courseId },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      await this.lockHead(tx, request.tenantId, request.courseId);
      const decisions = await this.archiveDecisions(
        tx,
        request.tenantId,
        request.courseId,
      );
      const action = archive ? 'archive' : 'unarchive';
      const replay = decisions.find((d) => d.requestKey === requestKey);
      if (replay) {
        if (
          replay.action !== action ||
          replay.delegationId !== (request.delegationId ?? '')
        )
          throw new CourseRequestKeyConflictError();
        return this.courseState(tx, request.tenantId, request.courseId);
      }
      const archived = decisions.at(-1)?.action === 'archive';
      if (archived === archive)
        return this.courseState(tx, request.tenantId, request.courseId);
      await (await CourseArchiveDecisionCollection.create({ db: tx })).create({
        _insertOnly: true,
        tenantId: request.tenantId,
        courseId: request.courseId,
        action,
        sequence: decisions.length + 1,
        actorUserId: request.actorUserId,
        ...delegationRecordFields(request),
        requestKey,
        recordedAt: new Date(),
      });
      // Release Course rows mirror the decision for catalog listings only.
      const releases = await tx.list('course_releases', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
      });
      const courses = await AuthoredCourseCollection.create({ db: tx });
      for (const release of releases) {
        const course = await courses.get(
          { id: String(release.release_course_id), tenantId: request.tenantId },
          { cache: false },
        );
        if (!course) continue;
        course.status = archive
          ? 'archived'
          : course.licenseKind === 'personal-use-copy'
            ? 'draft'
            : 'published';
        await course.save();
      }
      return this.courseState(tx, request.tenantId, request.courseId);
    });
  }

  /**
   * Discards a draft nothing references. History stays append-only: a tombstone
   * ends the draft, and erasing its rows belongs to a retention operation.
   */
  async discardDraft(
    request: CourseAuthoringActor & {
      courseId: string;
      requestKey: string;
      reason?: string;
    },
  ): Promise<CourseStateView> {
    const requestKey = requireKey(request.requestKey);
    const reason = text(request.reason, 'reason', 1000);
    return this.run(async (tx) => {
      await this.authorize(tx, request, 'education.course.archive', 'discard', {
        courseId: request.courseId,
      });
      await this.identityRow(tx, request.tenantId, request.courseId);
      const tombstone = await tx.get('course_discard_tombstones', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
      });
      if (tombstone) {
        if (tombstone.request_key !== requestKey)
          throw new CourseDiscardedError();
        if (
          String(tombstone.delegation_id ?? '') !== (request.delegationId ?? '')
        )
          throw new CourseRequestKeyConflictError();
        return this.courseState(tx, request.tenantId, request.courseId);
      }
      await this.lockHead(tx, request.tenantId, request.courseId);
      const references: string[] = [];
      if (
        (
          await tx.list('course_releases', {
            tenant_id: request.tenantId,
            course_id: request.courseId,
          })
        ).length
      )
        references.push('release');
      // Attempts, progress and submissions all hang from an enrollment.
      if (
        await tx.get('enrollments', {
          tenant_id: request.tenantId,
          course_id: request.courseId,
        })
      )
        references.push('enrollment');
      if (this.options.referenceGuard) {
        const guard = await this.options.referenceGuard(tx, {
          tenantId: request.tenantId,
          courseId: request.courseId,
        });
        if (guard?.referenced !== false)
          references.push(
            ...(guard?.kinds?.length ? guard.kinds : ['reference']),
          );
      }
      if (references.length) throw new CourseDiscardRefusedError(references);
      const head = await tx.get('course_draft_heads', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
      });
      const course = await tx.get('courses', {
        id: request.courseId,
        tenant_id: request.tenantId,
      });
      await (await CourseDiscardTombstoneCollection.create({ db: tx })).create({
        _insertOnly: true,
        tenantId: request.tenantId,
        courseId: request.courseId,
        title: String(course?.title ?? ''),
        headRevisionId: String(head?.head_revision_id ?? ''),
        revisionCount: (
          await tx.list('course_revisions', {
            tenant_id: request.tenantId,
            course_id: request.courseId,
          })
        ).length,
        reason,
        actorUserId: request.actorUserId,
        ...delegationRecordFields(request),
        requestKey,
        recordedAt: new Date(),
      });
      return this.courseState(tx, request.tenantId, request.courseId);
    });
  }

  // -- enrollment pins and upgrades -----------------------------------------

  private async enrollmentRow(tx: Tx, tenantId: string, enrollmentId: string) {
    const row =
      typeof enrollmentId === 'string' && enrollmentId
        ? await tx.get('enrollments', { id: enrollmentId, tenant_id: tenantId })
        : null;
    // A missing or foreign enrollment is indistinguishable from a denial.
    if (!row) throw new CourseAuthoringAuthorizationError();
    return row as Row;
  }

  private async pins(tx: Tx, tenantId: string, enrollmentId: string) {
    return (
      await (
        await EnrollmentReleasePinCollection.create({ db: tx })
      ).list({
        where: { tenantId, enrollmentId },
        limit: 100000,
      })
    ).sort((a, b) => a.sequence - b.sequence);
  }

  private async releaseRow(tx: Tx, tenantId: string, releaseId: string) {
    const row =
      typeof releaseId === 'string' && releaseId
        ? await tx.get('course_releases', {
            id: releaseId,
            tenant_id: tenantId,
          })
        : null;
    if (!row) throw new CourseNotFoundError();
    return row as Row;
  }

  /** The opt-in/out row that governs an enrollment: its own, else the course's. */
  private async governingChoice(
    tx: Tx,
    tenantId: string,
    courseId: string,
    enrollmentId: string,
  ): Promise<CourseUpgradeChoice | null> {
    const choices = (
      await (
        await CourseUpgradeChoiceCollection.create({ db: tx })
      ).list({
        where: { tenantId, courseId },
        limit: 100000,
      })
    ).sort((a, b) => a.sequence - b.sequence);
    const own = choices.filter((c) => c.enrollmentId === enrollmentId).at(-1);
    if (own) return own;
    return choices.filter((c) => c.enrollmentId === '').at(-1) ?? null;
  }

  private async autoUpgradeEnabled(
    tx: Tx,
    tenantId: string,
    courseId: string,
    enrollmentId: string,
  ): Promise<boolean> {
    return (
      (await this.governingChoice(tx, tenantId, courseId, enrollmentId))
        ?.enabled ?? false
    );
  }

  private async pinView(
    tx: Tx,
    tenantId: string,
    enrollmentId: string,
  ): Promise<EnrollmentPinView> {
    const pins = await this.pins(tx, tenantId, enrollmentId);
    const current = pins.at(-1);
    if (!current)
      throw new EnrollmentPinConflictError('Enrollment is not pinned');
    const release = await this.releaseRow(tx, tenantId, current.releaseId);
    // Release course ids come from the course's own release rows (one read).
    const releaseCourseIds = new Map(
      (
        await tx.list('course_releases', {
          tenant_id: tenantId,
          'id in': [...new Set(pins.map((p) => p.releaseId))],
        })
      ).map((r) => [String(r.id), String(r.release_course_id)]),
    );
    return {
      enrollmentId,
      learnerId: current.learnerId,
      courseId: current.courseId,
      releaseId: current.releaseId,
      releaseCourseId: String(release.release_course_id),
      releaseNumber: Number(release.release_number),
      kind: current.kind as EnrollmentPinKind,
      autoUpgrade: await this.autoUpgradeEnabled(
        tx,
        tenantId,
        current.courseId,
        enrollmentId,
      ),
      policyBasis: current.policyBasis,
      history: pins.map((p) => ({
        releaseId: p.releaseId,
        releaseCourseId: releaseCourseIds.get(p.releaseId) ?? '',
        previousReleaseId: optional(p.previousReleaseId),
        kind: p.kind as EnrollmentPinKind,
        sequence: p.sequence,
        actorUserId: optional(p.actorUserId),
        delegatingGuardianUserId: optional(p.delegatingGuardianUserId),
        delegationId: optional(p.delegationId),
        optInDelegationId: optional(p.optInDelegationId),
        policyBasis: p.policyBasis,
        optInScope: p.optInScope
          ? (p.optInScope as 'course' | 'enrollment')
          : null,
        recordedAt: iso(p.recordedAt),
      })),
    };
  }

  private async lockEnrollment(tx: Tx, tenantId: string, enrollmentId: string) {
    await tx.query(
      'UPDATE enrollments SET id = id WHERE id = ? AND tenant_id = ?',
      [enrollmentId, tenantId],
    );
  }

  private async appendPin(
    tx: Tx,
    actor: CourseAuthoringActor | null,
    tenantId: string,
    enrollment: Row,
    input: {
      releaseId: string;
      courseId: string;
      previous: EnrollmentReleasePin | undefined;
      kind: EnrollmentPinKind;
      requestKey: string;
      policyBasis: string;
      optInScope?: 'course' | 'enrollment';
      optInDelegationId?: string;
      sequence: number;
    },
  ) {
    return (await EnrollmentReleasePinCollection.create({ db: tx })).create({
      _insertOnly: true,
      tenantId,
      enrollmentId: String(enrollment.id),
      learnerId: String(enrollment.learner_id),
      courseId: input.courseId,
      releaseId: input.releaseId,
      previousReleaseId: input.previous?.releaseId ?? null,
      kind: input.kind,
      sequence: input.sequence,
      actorUserId: actor?.actorUserId ?? '',
      ...(actor
        ? delegationRecordFields(actor)
        : { delegatingGuardianUserId: '', delegationId: '' }),
      optInDelegationId: input.optInDelegationId ?? '',
      policyBasis: input.policyBasis,
      optInScope: input.optInScope ?? '',
      requestKey: input.requestKey,
      recordedAt: new Date(),
    });
  }

  /**
   * Records which release an existing enrollment follows. The enrollment must
   * already have been created on that release's materialized Course row.
   */
  async pinEnrollment(
    request: CourseAuthoringActor & {
      enrollmentId: string;
      releaseId: string;
      requestKey: string;
      policyBasis: string;
    },
  ): Promise<EnrollmentPinView> {
    return this.movePin(request, 'initial');
  }

  /** Explicit move of a pinned enrollment to a newer release of the same course. */
  async upgradeEnrollment(
    request: CourseAuthoringActor & {
      enrollmentId: string;
      releaseId: string;
      requestKey: string;
      policyBasis: string;
    },
  ): Promise<EnrollmentPinView> {
    return this.movePin(request, 'explicit');
  }

  private async movePin(
    request: CourseAuthoringActor & {
      enrollmentId: string;
      releaseId: string;
      requestKey: string;
      policyBasis: string;
    },
    kind: 'initial' | 'explicit',
  ): Promise<EnrollmentPinView> {
    const requestKey = requireKey(request.requestKey);
    const policyBasis = text(request.policyBasis, 'policy basis', 200, true);
    return this.run(async (tx) => {
      const enrollment = await this.enrollmentRow(
        tx,
        request.tenantId,
        request.enrollmentId,
      );
      // Context for the host: the target release's authored course and course row.
      // A missing release is not reported until after authorization, so an
      // unauthorized actor cannot probe release ids.
      const target =
        typeof request.releaseId === 'string' && request.releaseId
          ? await tx.get('course_releases', {
              id: request.releaseId,
              tenant_id: request.tenantId,
            })
          : null;
      await this.authorize(
        tx,
        request,
        'education.course.assign',
        kind === 'initial' ? 'pin-enrollment' : 'upgrade-enrollment',
        {
          enrollmentId: request.enrollmentId,
          learnerId: String(enrollment.learner_id),
          ...(target
            ? {
                courseId: String(target.course_id),
                releaseId: String(target.id),
                releaseCourseId: String(target.release_course_id),
              }
            : {}),
        },
      );
      await this.lockEnrollment(tx, request.tenantId, request.enrollmentId);
      const pins = await this.pins(tx, request.tenantId, request.enrollmentId);
      const replay = pins.find((p) => p.requestKey === requestKey);
      if (replay) {
        if (
          replay.kind !== kind ||
          replay.releaseId !== request.releaseId ||
          replay.policyBasis !== policyBasis ||
          replay.delegationId !== (request.delegationId ?? '')
        )
          throw new CourseRequestKeyConflictError();
        return this.pinView(tx, request.tenantId, request.enrollmentId);
      }
      const release = await this.releaseRow(
        tx,
        request.tenantId,
        request.releaseId,
      );
      const courseId = String(release.course_id);
      await this.writableDraft(tx, request.tenantId, courseId);
      if ((await this.state(tx, request.tenantId, courseId)) === 'archived')
        throw new CourseArchivedError();
      const previous = pins.at(-1);
      if (kind === 'initial') {
        if (previous)
          throw new EnrollmentPinConflictError(
            'Enrollment is already pinned; use an upgrade',
          );
        if (enrollment.course_id !== release.release_course_id)
          throw new EnrollmentPinConflictError(
            'Enrollment was not created on this release',
          );
      } else {
        if (!previous)
          throw new EnrollmentPinConflictError('Enrollment is not pinned');
        const current = await this.releaseRow(
          tx,
          request.tenantId,
          previous.releaseId,
        );
        if (
          previous.courseId !== courseId ||
          Number(release.release_number) <= Number(current.release_number)
        )
          throw new EnrollmentPinConflictError(
            'An upgrade must target a newer release of the same course',
          );
      }
      await this.appendPin(tx, request, request.tenantId, enrollment, {
        releaseId: request.releaseId,
        courseId,
        previous,
        kind,
        requestKey,
        policyBasis,
        sequence: pins.length + 1,
      });
      return this.pinView(tx, request.tenantId, request.enrollmentId);
    });
  }

  /**
   * Records an opt-in or opt-out of auto-upgrade for a course (all its pinned
   * enrollments) or one enrollment. It governs future releases only.
   */
  async setAutoUpgrade(
    request: CourseAuthoringActor & {
      courseId: string;
      enrollmentId?: string;
      enabled: boolean;
      requestKey: string;
      policyBasis: string;
    },
  ): Promise<SetAutoUpgradeResult> {
    const requestKey = requireKey(request.requestKey);
    const policyBasis = text(request.policyBasis, 'policy basis', 200, true);
    const enabled = bool(request.enabled, 'enabled');
    return this.run(async (tx) => {
      const enrollment = request.enrollmentId
        ? await this.enrollmentRow(tx, request.tenantId, request.enrollmentId)
        : null;
      await this.authorize(
        tx,
        request,
        'education.course.assign',
        'set-auto-upgrade',
        {
          courseId: request.courseId,
          ...(enrollment
            ? {
                enrollmentId: String(enrollment.id),
                learnerId: String(enrollment.learner_id),
              }
            : {}),
        },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      await this.lockHead(tx, request.tenantId, request.courseId);
      const choices = await CourseUpgradeChoiceCollection.create({ db: tx });
      const all = await choices.list({
        where: { tenantId: request.tenantId, courseId: request.courseId },
        limit: 100000,
      });
      const result: SetAutoUpgradeResult = {
        courseId: request.courseId,
        enrollmentId: request.enrollmentId ?? null,
        learnerId: enrollment ? String(enrollment.learner_id) : null,
        enabled,
        policyBasis,
      };
      const replay = all.find((c) => c.requestKey === requestKey);
      if (replay) {
        if (
          replay.enabled !== enabled ||
          replay.policyBasis !== policyBasis ||
          replay.delegationId !== (request.delegationId ?? '') ||
          replay.enrollmentId !== (request.enrollmentId ?? '')
        )
          throw new CourseRequestKeyConflictError();
        return result;
      }
      if (enrollment) {
        const pins = await this.pins(
          tx,
          request.tenantId,
          String(enrollment.id),
        );
        if (pins.at(-1)?.courseId !== request.courseId)
          throw new EnrollmentPinConflictError(
            'Enrollment is not pinned to a release of this course',
          );
      }
      await choices.create({
        _insertOnly: true,
        tenantId: request.tenantId,
        courseId: request.courseId,
        enrollmentId: request.enrollmentId ?? '',
        enabled,
        sequence: all.length + 1,
        actorUserId: request.actorUserId,
        ...delegationRecordFields(request),
        policyBasis,
        requestKey,
        recordedAt: new Date(),
      });
      return result;
    });
  }

  /**
   * Re-evaluates, per enrollment, the recorded opt-in actor's current authority
   * (and their delegating guardian's) for the `assign` action. Any denial or
   * failure means "do not move"; it never blocks the release itself.
   */
  private async authorizeAutoUpgrade(
    tx: Tx,
    tenantId: string,
    choice: CourseUpgradeChoice,
    enrollmentId: string,
    learnerId: string,
    courseId: string,
  ): Promise<{ allowed: boolean; reason: string; code: string }> {
    const denied = readDecision(false);
    try {
      const delegation = readDelegation({
        actorUserId: choice.actorUserId,
        delegatingGuardianUserId: choice.delegatingGuardianUserId,
        delegationId: choice.delegationId,
      });
      const members = [choice.actorUserId];
      if (delegation) members.push(delegation.delegatingGuardianUserId);
      for (const userId of members) {
        if (
          !userId ||
          !(await tx.get('memberships', {
            tenant_id: tenantId,
            user_id: userId,
            status: 'active',
          })) ||
          !(await tx.get('users', { id: userId, status: 'active' }))
        )
          return denied;
      }
      // A nested transaction is a SAVEPOINT: a failing statement inside the
      // host callback is rolled back to it, so it cannot leave the release
      // transaction aborted (PostgreSQL 25P02). A throw means "not allowed".
      // An executor that cannot nest cannot isolate the callback: fail closed.
      if (typeof tx.transaction !== 'function') return denied;
      return await tx.transaction(async (inner) => {
        if (delegation) {
          // The verifier's own reason/code (sanitized) is what the skip records.
          const verified = await this.delegationDecision(inner, {
            tenantId,
            actorUserId: choice.actorUserId,
            ...delegation,
            action: 'education.course.assign',
            operation: 'auto-upgrade',
            courseId,
            enrollmentId,
            learnerId,
          });
          if (verified.allowed !== true) return { ...verified, allowed: false };
        }
        return readDecision(
          await this.authorizer({
            tenantId,
            actorUserId: choice.actorUserId,
            ...(delegation ?? {}),
            courseId,
            enrollmentId,
            learnerId,
            action: 'education.course.assign',
            operation: 'auto-upgrade',
            executor: inner,
          }),
        );
      });
    } catch {
      // Never record a thrown message: the generic reason only.
      return denied;
    }
  }

  /** Moves opted-in enrollments to a new release; each move is recorded. */
  private async autoUpgrade(
    tx: Tx,
    tenantId: string,
    courseId: string,
    release: CourseRelease,
  ): Promise<void> {
    const rows = await (
      await EnrollmentReleasePinCollection.create({ db: tx })
    ).list({
      where: { tenantId, courseId },
      limit: 1000000,
    });
    const latest = new Map<string, EnrollmentReleasePin>();
    for (const pin of rows.sort((a, b) => a.sequence - b.sequence))
      latest.set(pin.enrollmentId, pin);
    for (const [enrollmentId, previous] of latest) {
      if (previous.releaseId === String(release.id)) continue;
      const choice = await this.governingChoice(
        tx,
        tenantId,
        courseId,
        enrollmentId,
      );
      if (!choice?.enabled) continue;
      const enrollment = await tx.get('enrollments', {
        id: enrollmentId,
        tenant_id: tenantId,
      });
      if (!enrollment) continue;
      const optInScope = choice.enrollmentId ? 'enrollment' : 'course';
      const learnerId = String((enrollment as Row).learner_id);
      await this.lockEnrollment(tx, tenantId, enrollmentId);
      const decision = await this.authorizeAutoUpgrade(
        tx,
        tenantId,
        choice,
        enrollmentId,
        learnerId,
        courseId,
      );
      if (!decision.allowed) {
        await (
          await EnrollmentAutoUpgradeSkipCollection.create({ db: tx })
        ).create({
          _insertOnly: true,
          tenantId,
          enrollmentId,
          learnerId,
          courseId,
          releaseId: String(release.id),
          optInScope,
          optInActorUserId: choice.actorUserId,
          optInDelegatingGuardianUserId: choice.delegatingGuardianUserId,
          optInDelegationId: choice.delegationId,
          policyBasis: choice.policyBasis,
          reason: decision.reason,
          code: decision.code,
          recordedAt: new Date(),
        });
        continue;
      }
      await this.appendPin(tx, null, tenantId, enrollment as Row, {
        releaseId: String(release.id),
        courseId,
        previous,
        kind: 'auto',
        requestKey: `auto:${String(release.id)}`,
        policyBasis: choice.policyBasis,
        optInScope,
        optInDelegationId: choice.delegationId,
        sequence: (await this.pins(tx, tenantId, enrollmentId)).length + 1,
      });
    }
  }

  /**
   * The enrollment's current release plus the lessons that apply to it. Started
   * lessons stay on the immutable row they were started on after any move.
   */
  async getEnrollmentRelease(
    request: CourseAuthoringActor & { enrollmentId: string },
  ): Promise<EnrollmentReleaseView> {
    return this.run(async (tx) => {
      const enrollment = await this.enrollmentRow(
        tx,
        request.tenantId,
        request.enrollmentId,
      );
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-enrollment',
        {
          enrollmentId: request.enrollmentId,
          learnerId: String(enrollment.learner_id),
        },
      );
      const pin = await this.pinView(
        tx,
        request.tenantId,
        request.enrollmentId,
      );
      const selection = await resolveEnrollmentLessons(
        tx,
        request.tenantId,
        request.enrollmentId,
      );
      return {
        learnerId: pin.learnerId,
        courseId: pin.courseId,
        releaseCourseId: pin.releaseCourseId,
        pin,
        lessons: selection?.lessons ?? [],
      };
    });
  }
}

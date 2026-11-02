/**
 * Pure question extraction: closed argument schema, validation against retained
 * evidence, source identity, the evidence-only matcher and the mapping onto
 * question content (SMRT #4517). No I/O; see `agents/question-extraction.md`.
 */
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  QUESTION_RESPONSE_TYPES,
  type QuestionChoice,
  type QuestionContentInput,
  type QuestionField,
  type QuestionProvenance,
  type QuestionResponseType,
  type WorksheetBundle,
} from './question-contracts.js';
import {
  EXTRACTED_LEGIBILITY,
  EXTRACTED_MEDIA_KINDS,
  EXTRACTED_OMISSION_REASONS,
  EXTRACTED_ORIGINS,
  EXTRACTED_PAGE_ROLES,
  EXTRACTED_QUESTION_STATUSES,
  EXTRACTED_READABILITY,
  type ExtractedAnchor,
  type ExtractedAnchorInput,
  type ExtractedOrigin,
  type ExtractedQuestion,
  type ExtractedStudentWork,
  MAX_EXTRACTED_ANCHORS,
  MAX_EXTRACTED_OMISSIONS,
  MAX_EXTRACTED_PAGES,
  MAX_EXTRACTED_QUESTIONS,
  MAX_EXTRACTED_SECTIONS,
  MAX_EXTRACTED_STUDENT_WORK,
  MAX_EXTRACTED_TEXT,
  QUESTION_EXTRACTION_SOURCE_KINDS,
  type QuestionExtraction,
  type QuestionExtractionGrounding,
  type QuestionExtractionMatch,
  type QuestionExtractionSourceKind,
  QuestionExtractionValidationError,
  type QuestionMatch,
} from './question-extraction-contracts.js';
import { canonical } from './question-render.js';

const KEY = /^[A-Za-z0-9._:-]{1,80}$/;
const WORKSHEET_ID = /^wsv1-[0-9a-f]{40}$/;

// -- closed JSON schema -------------------------------------------------------

const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: 'null' }],
});
const text = (maxLength: number) => ({
  type: 'string',
  minLength: 1,
  maxLength,
});
const key = { type: 'string', pattern: KEY.source };
const origin = { type: 'string', enum: [...EXTRACTED_ORIGINS] };
const page = nullable({ type: 'integer', minimum: 1, maximum: 100_000 });
const anchor = {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceId', 'page', 'regionId'],
  properties: {
    evidenceId: text(200),
    page,
    regionId: nullable(text(64)),
  },
};
const anchors = {
  type: 'array',
  maxItems: MAX_EXTRACTED_ANCHORS,
  items: anchor,
};

/**
 * Closed argument schema of the `extract-questions` handler: what a proposal
 * generator may fill. Every object is closed; every optional fact is explicit null.
 */
export const QUESTION_EXTRACTION_ARGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'sourceKind',
    'worksheetVersionId',
    'pages',
    'sections',
    'questions',
    'studentWork',
    'omissions',
  ],
  properties: {
    version: { type: 'integer', enum: [1] },
    sourceKind: { type: 'string', enum: [...QUESTION_EXTRACTION_SOURCE_KINDS] },
    worksheetVersionId: nullable({
      type: 'string',
      pattern: WORKSHEET_ID.source,
    }),
    pages: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_EXTRACTED_PAGES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceId', 'page', 'role', 'readability'],
        properties: {
          evidenceId: text(200),
          page,
          role: { type: 'string', enum: [...EXTRACTED_PAGE_ROLES] },
          readability: { type: 'string', enum: [...EXTRACTED_READABILITY] },
        },
      },
    },
    sections: {
      type: 'array',
      maxItems: MAX_EXTRACTED_SECTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'evidenceId', 'page'],
        properties: {
          id: key,
          label: nullable(text(500)),
          evidenceId: text(200),
          page,
        },
      },
    },
    questions: {
      type: 'array',
      maxItems: MAX_EXTRACTED_QUESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'numbering',
          'role',
          'sectionId',
          'status',
          'prompt',
          'responseType',
          'responseTypeOrigin',
          'choices',
          'subparts',
          'media',
          'answerKey',
          'rubric',
          'pointsPossible',
          'pointsOrigin',
          'anchors',
        ],
        properties: {
          key,
          numbering: nullable(text(40)),
          role: { type: 'string', enum: ['exercise', 'example'] },
          sectionId: nullable(key),
          status: { type: 'string', enum: [...EXTRACTED_QUESTION_STATUSES] },
          prompt: nullable(text(MAX_EXTRACTED_TEXT)),
          responseType: nullable({
            type: 'string',
            enum: [...QUESTION_RESPONSE_TYPES],
          }),
          responseTypeOrigin: origin,
          choices: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label'],
              properties: { id: key, label: text(2000) },
            },
          },
          subparts: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['partKey', 'prompt'],
              properties: { partKey: key, prompt: text(MAX_EXTRACTED_TEXT) },
            },
          },
          media: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'description', 'anchor'],
              properties: {
                kind: { type: 'string', enum: [...EXTRACTED_MEDIA_KINDS] },
                description: text(1000),
                anchor: nullable(anchor),
              },
            },
          },
          answerKey: nullable({
            type: 'object',
            additionalProperties: false,
            required: ['origin'],
            properties: {
              acceptedAnswers: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                items: text(2000),
              },
              correctChoiceIds: {
                type: 'array',
                minItems: 1,
                maxItems: 50,
                items: key,
              },
              numeric: { type: 'number' },
              origin,
            },
          }),
          rubric: nullable({
            type: 'object',
            additionalProperties: false,
            required: ['criteria', 'origin'],
            properties: {
              criteria: {
                type: 'array',
                minItems: 1,
                maxItems: 50,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'label', 'maxPoints'],
                  properties: {
                    id: key,
                    label: text(500),
                    maxPoints: { type: 'number', exclusiveMinimum: 0 },
                  },
                },
              },
              origin,
            },
          }),
          pointsPossible: nullable({ type: 'number', exclusiveMinimum: 0 }),
          pointsOrigin: nullable(origin),
          anchors,
        },
      },
    },
    studentWork: {
      type: 'array',
      maxItems: MAX_EXTRACTED_STUDENT_WORK,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['questionKey', 'observed', 'legibility', 'anchors'],
        properties: {
          questionKey: nullable(key),
          observed: nullable(text(MAX_EXTRACTED_TEXT)),
          legibility: { type: 'string', enum: [...EXTRACTED_LEGIBILITY] },
          anchors,
        },
      },
    },
    omissions: {
      type: 'array',
      maxItems: MAX_EXTRACTED_OMISSIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceId', 'page', 'reason', 'description'],
        properties: {
          evidenceId: text(200),
          page,
          reason: { type: 'string', enum: [...EXTRACTED_OMISSION_REASONS] },
          description: text(1000),
        },
      },
    },
  },
} as const;

// -- validation ---------------------------------------------------------------

const bad = (message: string): never => {
  throw new QuestionExtractionValidationError(message);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function closedObject(
  value: unknown,
  keys: readonly string[],
  what: string,
): Record<string, unknown> {
  if (!isObject(value)) return bad(`Invalid ${what}`);
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((k) => !keys.includes(k)))
    bad(`Invalid ${what} fields`);
  return value;
}
/** Text that survives storage: no NUL or lone surrogates, trimmed non-empty, bounded. */
function storable(value: unknown, max: number, what: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 0 || (code >= 0xd800 && code <= 0xdfff);
    })
  )
    return bad(`Invalid ${what}`);
  return value;
}
function nullableText(value: unknown, max: number, what: string) {
  return value === null ? null : storable(value, max, what);
}
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (!allowed.includes(value as T)) bad(`Invalid ${what}`);
  return value as T;
}
function list(value: unknown, max: number, what: string, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    return bad(`Invalid ${what}`);
  return value;
}
function idKey(value: unknown, what: string): string {
  if (typeof value !== 'string' || !KEY.test(value)) bad(`Invalid ${what}`);
  return value as string;
}
function positive(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    bad(`Invalid ${what}`);
  return value as number;
}

type Source = QuestionExtractionGrounding['sources'][number];

function sourceOf(
  grounding: QuestionExtractionGrounding,
  evidenceId: unknown,
): Source {
  const source = grounding.sources.find((s) => s.evidenceId === evidenceId);
  if (!source) return bad('Extraction cites evidence outside this intake');
  return source;
}
/** A page must be one the provider actually reported (or 1 for a single image). */
function pageOf(source: Source, value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    return bad('Invalid page');
  const known = source.pages.length
    ? source.pages.includes(value as number)
    : value === 1;
  if (!known) bad('Extraction cites a page the evidence does not have');
  return value as number;
}
function resolveAnchor(
  grounding: QuestionExtractionGrounding,
  value: unknown,
): ExtractedAnchor {
  const a = closedObject(value, ['evidenceId', 'page', 'regionId'], 'anchor');
  const source = sourceOf(grounding, a.evidenceId);
  const resolvedPage = pageOf(source, a.page);
  let rect: ExtractedAnchor['rect'] = null;
  if (a.regionId !== null) {
    const region = source.observedRegions?.regions.find(
      (r) => r.id === a.regionId,
    );
    // Never invent coordinates: a region must be in the provider's catalog.
    if (!region) bad('Extraction cites an unknown observed region');
    rect = [...(region as { rect: [number, number, number, number] }).rect];
  }
  return {
    evidenceId: source.evidenceId,
    sha256: source.sha256,
    page: resolvedPage,
    regionId: a.regionId === null ? null : String(a.regionId),
    rect,
  };
}
function resolveAnchors(
  grounding: QuestionExtractionGrounding,
  value: unknown,
) {
  return list(value, MAX_EXTRACTED_ANCHORS, 'anchors').map((a) =>
    resolveAnchor(grounding, a),
  );
}

/**
 * Validate extractor output against the closed contract and the intake's
 * retained evidence. Every source page must be accounted for (an entry in
 * `pages`), so unreadable or unsupported content is marked, never dropped.
 * Throws `QuestionExtractionValidationError`; never repairs or guesses.
 */
export function normalizeQuestionExtraction(
  value: unknown,
  grounding: QuestionExtractionGrounding,
): QuestionExtraction {
  if (!grounding?.sources?.length) bad('Extraction has no retained evidence');
  const v = closedObject(
    value,
    QUESTION_EXTRACTION_ARGS_SCHEMA.required,
    'extraction',
  );
  if (v.version !== 1) bad('Unsupported extraction version');
  const sourceKind = oneOf(
    v.sourceKind,
    QUESTION_EXTRACTION_SOURCE_KINDS,
    'source kind',
  );
  if (
    v.worksheetVersionId !== null &&
    (typeof v.worksheetVersionId !== 'string' ||
      !WORKSHEET_ID.test(v.worksheetVersionId))
  )
    bad('Invalid worksheet version id');

  const pageKeys = new Set<string>();
  const pages = list(v.pages, MAX_EXTRACTED_PAGES, 'pages', 1).map((entry) => {
    const p = closedObject(
      entry,
      ['evidenceId', 'page', 'role', 'readability'],
      'page',
    );
    const source = sourceOf(grounding, p.evidenceId);
    const resolved = pageOf(source, p.page);
    const id = `${source.evidenceId}\u0000${resolved ?? ''}`;
    if (pageKeys.has(id)) bad('Duplicate page entry');
    pageKeys.add(id);
    return {
      evidenceId: source.evidenceId,
      page: resolved,
      role: oneOf(p.role, EXTRACTED_PAGE_ROLES, 'page role'),
      readability: oneOf(p.readability, EXTRACTED_READABILITY, 'readability'),
    };
  });
  // Coverage: each retained source, and each of its known pages, is reported.
  // What ingestion itself never extracted is added visibly, never dropped.
  const notExtracted: QuestionExtraction['omissions'] = [];
  for (const source of grounding.sources) {
    const required = source.pages.length ? source.pages : [null];
    for (const p of required) {
      const covered =
        pageKeys.has(`${source.evidenceId}\u0000${p ?? ''}`) ||
        (p === null && pageKeys.has(`${source.evidenceId}\u00001`));
      if (covered) continue;
      const missing =
        source.extracted === false ||
        (p !== null && (source.omittedPages ?? []).includes(p));
      if (!missing) bad('Extraction omits a retained source page');
      pages.push({
        evidenceId: source.evidenceId,
        page: p,
        role: 'unknown',
        readability: 'unreadable',
      });
      notExtracted.push({
        evidenceId: source.evidenceId,
        page: p,
        reason: 'not_extracted',
        description:
          'Not extracted by ingestion (truncated output or a failed page).',
      });
    }
  }
  const sourceWarnings = [
    ...new Set([
      ...list(grounding.warnings ?? [], 16, 'source warnings').map((w) => {
        if (typeof w !== 'string' || !/^[a-z][a-z0-9_.-]{0,47}$/.test(w))
          bad('Invalid source warning');
        return w as string;
      }),
      ...(grounding.sources.some(
        (s) => s.extracted === false || s.incomplete || s.omittedPages?.length,
      )
        ? ['source_incomplete']
        : []),
    ]),
  ].sort();

  const sectionIds = new Set<string>();
  const sections = list(v.sections, MAX_EXTRACTED_SECTIONS, 'sections').map(
    (entry) => {
      const s = closedObject(
        entry,
        ['id', 'label', 'evidenceId', 'page'],
        'section',
      );
      const id = idKey(s.id, 'section id');
      if (sectionIds.has(id)) bad('Duplicate section id');
      sectionIds.add(id);
      const source = sourceOf(grounding, s.evidenceId);
      return {
        id,
        label: nullableText(s.label, 500, 'section label'),
        evidenceId: source.evidenceId,
        page: pageOf(source, s.page),
      };
    },
  );

  const questionKeys = new Set<string>();
  const questions = list(v.questions, MAX_EXTRACTED_QUESTIONS, 'questions').map(
    (entry) => normalizeQuestion(entry, grounding, sectionIds, questionKeys),
  );

  const studentWork = list(
    v.studentWork,
    MAX_EXTRACTED_STUDENT_WORK,
    'student work',
  ).map((entry): ExtractedStudentWork => {
    const w = closedObject(
      entry,
      ['questionKey', 'observed', 'legibility', 'anchors'],
      'student work',
    );
    if (w.questionKey !== null && !questionKeys.has(w.questionKey as string))
      bad('Student work names an unknown question');
    const legibility = oneOf(w.legibility, EXTRACTED_LEGIBILITY, 'legibility');
    const observed = nullableText(w.observed, MAX_EXTRACTED_TEXT, 'response');
    // An illegible response is unknown, never a transcription.
    if (legibility === 'illegible' && observed !== null)
      bad('Illegible work cannot carry a transcription');
    return {
      questionKey: w.questionKey as string | null,
      observed,
      legibility,
      anchors: resolveAnchors(grounding, w.anchors),
    };
  });

  const omissions = list(v.omissions, MAX_EXTRACTED_OMISSIONS, 'omissions').map(
    (entry) => {
      const o = closedObject(
        entry,
        ['evidenceId', 'page', 'reason', 'description'],
        'omission',
      );
      const source = sourceOf(grounding, o.evidenceId);
      return {
        evidenceId: source.evidenceId,
        page: pageOf(source, o.page),
        reason: oneOf(o.reason, EXTRACTED_OMISSION_REASONS, 'omission reason'),
        description: storable(o.description, 1000, 'omission description'),
      };
    },
  );

  return {
    version: 1,
    sourceKind,
    worksheetVersionId: v.worksheetVersionId as string | null,
    pages,
    sections,
    questions,
    studentWork,
    omissions: [...omissions, ...notExtracted],
    sourceWarnings,
  };
}

function normalizeQuestion(
  entry: unknown,
  grounding: QuestionExtractionGrounding,
  sectionIds: ReadonlySet<string>,
  seen: Set<string>,
): ExtractedQuestion {
  const q = closedObject(
    entry,
    QUESTION_EXTRACTION_ARGS_SCHEMA.properties.questions.items.required,
    'question',
  );
  const key = idKey(q.key, 'question key');
  if (seen.has(key)) bad('Duplicate question key');
  seen.add(key);
  if (q.sectionId !== null && !sectionIds.has(q.sectionId as string))
    bad('Question names an unknown section');
  const status = oneOf(q.status, EXTRACTED_QUESTION_STATUSES, 'status');
  const prompt = nullableText(q.prompt, MAX_EXTRACTED_TEXT, 'prompt');
  const readable = status === 'complete' || status === 'partial';
  // A readable item carries printed text; an unreadable one never pretends to.
  if (readable !== (prompt !== null))
    bad('Prompt presence must follow question status');
  const responseType =
    q.responseType === null
      ? null
      : oneOf(q.responseType, QUESTION_RESPONSE_TYPES, 'response type');
  if (status === 'complete' && responseType === null)
    bad('A complete question needs a response type');
  const choiceIds = new Set<string>();
  const choices = list(q.choices, 50, 'choices').map((c): QuestionChoice => {
    const o = closedObject(c, ['id', 'label'], 'choice');
    const id = idKey(o.id, 'choice id');
    if (choiceIds.has(id)) bad('Duplicate choice id');
    choiceIds.add(id);
    return { id, label: storable(o.label, 2000, 'choice label') };
  });
  const partKeys = new Set<string>();
  const subparts = list(q.subparts, 50, 'subparts').map((p) => {
    const o = closedObject(p, ['partKey', 'prompt'], 'subpart');
    const partKey = idKey(o.partKey, 'subpart key');
    if (partKeys.has(partKey)) bad('Duplicate subpart key');
    partKeys.add(partKey);
    return {
      partKey,
      prompt: storable(o.prompt, MAX_EXTRACTED_TEXT, 'subpart prompt'),
    };
  });
  const media = list(q.media, 20, 'media').map((m) => {
    const o = closedObject(m, ['kind', 'description', 'anchor'], 'media');
    return {
      kind: oneOf(o.kind, EXTRACTED_MEDIA_KINDS, 'media kind'),
      description: storable(o.description, 1000, 'media description'),
      anchor: o.anchor === null ? null : resolveAnchor(grounding, o.anchor),
    };
  });
  let answerKey: ExtractedQuestion['answerKey'] = null;
  if (q.answerKey !== null) {
    if (!isObject(q.answerKey)) bad('Invalid answer key');
    const k = q.answerKey as Record<string, unknown>;
    for (const name of Object.keys(k))
      if (
        !['acceptedAnswers', 'correctChoiceIds', 'numeric', 'origin'].includes(
          name,
        )
      )
        bad('Invalid answer key fields');
    answerKey = { origin: oneOf(k.origin, EXTRACTED_ORIGINS, 'key origin') };
    if (k.acceptedAnswers !== undefined)
      answerKey.acceptedAnswers = list(k.acceptedAnswers, 20, 'answers', 1).map(
        (a) => storable(a, 2000, 'answer'),
      );
    if (k.correctChoiceIds !== undefined)
      answerKey.correctChoiceIds = list(
        k.correctChoiceIds,
        50,
        'correct choices',
        1,
      ).map((id) => {
        if (!choiceIds.has(id as string))
          bad('Answer key names an unknown choice');
        return id as string;
      });
    if (k.numeric !== undefined) {
      if (typeof k.numeric !== 'number' || !Number.isFinite(k.numeric))
        bad('Invalid numeric key');
      answerKey.numeric = k.numeric as number;
    }
    // An empty key is never a key: a missing key stays null.
    if (
      !answerKey.acceptedAnswers &&
      !answerKey.correctChoiceIds &&
      answerKey.numeric === undefined
    )
      bad('An answer key needs at least one accepted answer');
  }
  let rubric: ExtractedQuestion['rubric'] = null;
  if (q.rubric !== null) {
    const r = closedObject(q.rubric, ['criteria', 'origin'], 'rubric');
    const ids = new Set<string>();
    rubric = {
      origin: oneOf(r.origin, EXTRACTED_ORIGINS, 'rubric origin'),
      criteria: list(r.criteria, 50, 'criteria', 1).map((c) => {
        const o = closedObject(c, ['id', 'label', 'maxPoints'], 'criterion');
        const id = idKey(o.id, 'criterion id');
        if (ids.has(id)) bad('Duplicate criterion id');
        ids.add(id);
        return {
          id,
          label: storable(o.label, 500, 'criterion label'),
          maxPoints: positive(o.maxPoints, 'criterion points'),
        };
      }),
    };
  }
  const pointsPossible =
    q.pointsPossible === null ? null : positive(q.pointsPossible, 'points');
  const pointsOrigin =
    q.pointsOrigin === null
      ? null
      : oneOf(q.pointsOrigin, EXTRACTED_ORIGINS, 'points origin');
  if ((pointsPossible === null) !== (pointsOrigin === null))
    bad('Points and their origin go together');
  return {
    key,
    numbering: nullableText(q.numbering, 40, 'numbering'),
    role: oneOf(q.role, ['exercise', 'example'] as const, 'question role'),
    sectionId: q.sectionId as string | null,
    status,
    prompt,
    responseType,
    responseTypeOrigin: oneOf(
      q.responseTypeOrigin,
      EXTRACTED_ORIGINS,
      'response type origin',
    ),
    choices,
    subparts,
    media,
    answerKey,
    rubric,
    pointsPossible,
    pointsOrigin,
    anchors: resolveAnchors(grounding, q.anchors),
  };
}

// -- identity -----------------------------------------------------------------

/**
 * Idempotency identity of an extraction source: the source kind plus the
 * sorted retained evidence hashes. Re-ingesting the same bytes yields the same
 * identity; a fresh scan (new bytes) is a new source. Never derived from text.
 */
export function questionExtractionSourceIdentity(
  sourceKind: QuestionExtractionSourceKind,
  grounding: QuestionExtractionGrounding,
): string {
  const hashes = [...new Set(grounding.sources.map((s) => s.sha256))].sort();
  return `qxs1-${groupSharingDigest(canonical({ sourceKind, hashes })).slice(0, 40)}`;
}

// -- matching -----------------------------------------------------------------

const POSITION = /^\s*(?:q(?:uestion)?\.?\s*)?(\d{1,4})\s*[.):]?\s*$/i;
const normalLabel = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * Link extracted questions to known worksheet revisions on evidence only: a
 * worksheet identity (printed on the page, or supplied by the host) plus the
 * printed position, checked against section, response type, choice and part
 * counts. Prompt text is never used. Conflicts and duplicate claims are
 * `ambiguous` and stay unattached.
 */
export function matchExtractedQuestions(
  extraction: QuestionExtraction,
  worksheets: readonly WorksheetBundle[],
  options: { expectedWorksheetVersionId?: string } = {},
): QuestionExtractionMatch {
  const observed = extraction.worksheetVersionId;
  const expected = options.expectedWorksheetVersionId ?? null;
  const all = (
    outcome: QuestionMatch['outcome'],
    reason: QuestionMatch['reason'],
  ) =>
    extraction.questions.map(
      (q): QuestionMatch => ({
        key: q.key,
        outcome: q.role === 'example' ? 'unmatched' : outcome,
        reason: q.role === 'example' ? 'not_an_exercise' : reason,
        questionId: null,
        questionRevisionId: null,
        ordinal: null,
      }),
    );
  if (observed && expected && observed !== expected)
    return {
      worksheetVersionId: null,
      worksheetSource: null,
      worksheetKnown: false,
      questions: all('ambiguous', 'worksheet_conflict'),
    };
  const id = observed ?? expected;
  const source = observed ? 'observed' : expected ? 'expected' : null;
  if (!id)
    return {
      worksheetVersionId: null,
      worksheetSource: null,
      worksheetKnown: false,
      questions: all('unmatched', 'no_worksheet_identifier'),
    };
  const worksheet = worksheets.find((w) => w.worksheetVersionId === id);
  if (!worksheet)
    return {
      worksheetVersionId: id,
      worksheetSource: source,
      worksheetKnown: false,
      questions: all('unmatched', 'unknown_worksheet'),
    };
  const sections = new Map(extraction.sections.map((s) => [s.id, s]));
  const proposed = extraction.questions.map((q): QuestionMatch => {
    const none = (
      outcome: QuestionMatch['outcome'],
      reason: QuestionMatch['reason'],
      ordinal: number | null = null,
    ): QuestionMatch => ({
      key: q.key,
      outcome,
      reason,
      questionId: null,
      questionRevisionId: null,
      ordinal,
    });
    if (q.role === 'example') return none('unmatched', 'not_an_exercise');
    const position = q.numbering ? POSITION.exec(q.numbering) : null;
    if (!position) return none('unmatched', 'no_layout_position');
    const ordinal = Number(position[1]);
    const item = worksheet.items.find((i) => i.ordinal === ordinal);
    if (!item) return none('unmatched', 'position_not_on_worksheet', ordinal);
    const label = q.sectionId ? sections.get(q.sectionId)?.label : null;
    const conflict =
      (label &&
        item.section &&
        normalLabel(label) !== normalLabel(item.section)) ||
      (q.responseType &&
        q.responseTypeOrigin === 'source' &&
        q.responseType !== item.responseType) ||
      (q.choices.length > 0 &&
        item.choices.length > 0 &&
        q.choices.length !== item.choices.length) ||
      (q.subparts.length > 0 &&
        item.subparts.length > 0 &&
        q.subparts.length !== item.subparts.length);
    if (conflict) return none('ambiguous', 'layout_conflict', ordinal);
    return {
      key: q.key,
      outcome: 'matched',
      reason: 'worksheet_position',
      questionId: item.questionId,
      questionRevisionId: item.questionRevisionId,
      ordinal,
    };
  });
  // Two extracted items claiming one position: neither is attached.
  // Every claimant of an existing position counts, including ones that failed a
  // layout check, so a contested position never matches.
  const claims = new Map<number, number>();
  for (const m of proposed)
    if (
      m.ordinal !== null &&
      (m.outcome === 'matched' || m.reason === 'layout_conflict')
    )
      claims.set(m.ordinal, (claims.get(m.ordinal) ?? 0) + 1);
  const questions = proposed.map((m) =>
    m.outcome === 'matched' && (claims.get(m.ordinal as number) ?? 0) > 1
      ? {
          ...m,
          outcome: 'ambiguous' as const,
          reason: 'duplicate_position' as const,
          questionId: null,
          questionRevisionId: null,
        }
      : m,
  );
  return {
    worksheetVersionId: id,
    worksheetSource: source,
    worksheetKnown: true,
    questions,
  };
}

// -- question content ---------------------------------------------------------

const provenanceOf = (origin: ExtractedOrigin): QuestionProvenance =>
  origin === 'source' ? 'extracted' : 'inferred';

/**
 * Question content for a readable printed exercise, or null when the item must
 * not become a record (an example, or unreadable/unsupported). Printed facts are
 * `extracted`; extractor guesses are `inferred`. Student work never enters here.
 */
export function extractedQuestionContent(
  question: ExtractedQuestion,
): QuestionContentInput | null {
  if (
    question.role !== 'exercise' ||
    question.prompt === null ||
    question.responseType === null
  )
    return null;
  const fieldProvenance: Partial<Record<QuestionField, QuestionProvenance>> = {
    prompt: 'extracted',
    responseType: provenanceOf(question.responseTypeOrigin),
  };
  const content: QuestionContentInput = {
    prompt: question.prompt,
    responseType: question.responseType as QuestionResponseType,
    provenance: 'extracted',
    fieldProvenance,
  };
  if (question.choices.length) {
    content.choices = question.choices.map((c) => ({ ...c }));
    fieldProvenance.choices = 'extracted';
  }
  if (question.subparts.length) {
    content.subparts = question.subparts.map((p) => ({ ...p }));
    fieldProvenance.subparts = 'extracted';
  }
  if (question.answerKey) {
    const { origin, numeric, ...rest } = question.answerKey;
    content.answerKey = {
      ...rest,
      ...(numeric !== undefined ? { numeric: { value: numeric } } : {}),
    };
    fieldProvenance.answerKey = provenanceOf(origin);
  }
  if (question.rubric) {
    content.rubric = {
      criteria: question.rubric.criteria.map((c) => ({ ...c })),
    };
    fieldProvenance.rubric = provenanceOf(question.rubric.origin);
  }
  if (question.pointsPossible !== null && question.pointsOrigin) {
    content.pointsPossible = question.pointsPossible;
    fieldProvenance.pointsPossible = provenanceOf(question.pointsOrigin);
  }
  return content;
}

/** Re-exported for hosts building their own anchor display. */
export type { ExtractedAnchor, ExtractedAnchorInput };

import { CourseAuthoringValidationError } from './course-authoring-contracts.js';
import {
  QUESTION_FIELDS,
  QUESTION_PROVENANCES,
  QUESTION_RESPONSE_TYPES,
  type QuestionAnswerAtom,
  type QuestionAnswerKey,
  type QuestionChoice,
  type QuestionContentInput,
  type QuestionField,
  type QuestionMediaRef,
  type QuestionProvenance,
  type QuestionResponseType,
  type QuestionRubric,
  type QuestionSubpart,
} from './question-contracts.js';
import { parseQuestionRubric } from './question-rubric.js';

const ID = /^[A-Za-z0-9._:-]{1,80}$/;
const CONCEPT = /^[A-Za-z0-9._:/-]{1,200}$/;

export interface NormalizedQuestionContent {
  prompt: string;
  responseType: QuestionResponseType;
  choices: QuestionChoice[];
  subparts: QuestionSubpart[];
  media: Required<QuestionMediaRef>[];
  objectiveIds: string[];
  conceptIds: string[];
  /** Null when no key was supplied; never an empty key. */
  answerKey: QuestionAnswerKey | null;
  rubric: QuestionRubric | null;
  pointsPossible: number | null;
  provenance: QuestionProvenance;
  /** Effective provenance of every present field; absent fields have no entry. */
  fieldProvenance: Partial<Record<QuestionField, QuestionProvenance>>;
}

const bad = (message: string): never => {
  throw new CourseAuthoringValidationError(message);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function onlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) bad(`Unknown ${what} field`);
}
function strings(value: unknown, what: string, max: number, itemMax: number) {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((v) => typeof v !== 'string' || !v.trim() || v.length > itemMax)
  )
    return bad(`Invalid ${what}`);
  return value as string[];
}
function unique<T>(values: T[], what: string): T[] {
  if (new Set(values).size !== values.length) bad(`Duplicate ${what}`);
  return values;
}

function atom(
  value: unknown,
  choiceIds: ReadonlySet<string> | null,
  what: string,
): QuestionAnswerAtom {
  if (!isObject(value)) return bad(`Invalid ${what}`);
  onlyKeys(value, ['correctChoiceIds', 'acceptedAnswers', 'numeric'], what);
  const result: QuestionAnswerAtom = {};
  if (value.correctChoiceIds !== undefined) {
    const ids = unique(
      strings(value.correctChoiceIds, `${what} choices`, 50, 80),
      'correct choice',
    );
    if (!ids.length || !choiceIds || ids.some((id) => !choiceIds.has(id)))
      bad(`${what} names an unknown choice`);
    result.correctChoiceIds = ids;
  }
  if (value.acceptedAnswers !== undefined) {
    const answers = strings(value.acceptedAnswers, `${what} answers`, 50, 1000);
    if (!answers.length) bad(`Invalid ${what} answers`);
    result.acceptedAnswers = answers;
  }
  if (value.numeric !== undefined) {
    const n = value.numeric as Record<string, unknown> | null;
    if (
      !isObject(n) ||
      typeof n.value !== 'number' ||
      !Number.isFinite(n.value) ||
      (n.tolerance !== undefined &&
        (typeof n.tolerance !== 'number' ||
          !Number.isFinite(n.tolerance) ||
          n.tolerance < 0))
    )
      return bad(`Invalid ${what} number`);
    onlyKeys(n, ['value', 'tolerance'], what);
    result.numeric = {
      value: n.value,
      tolerance: (n.tolerance as number | undefined) ?? 0,
    };
  }
  if (!Object.keys(result).length) bad(`${what} cannot be empty`);
  return result;
}

/**
 * Validates and normalizes authored question content. Pure; ownership checks
 * (assets, objectives) are the caller's. Throws `CourseAuthoringValidationError`.
 */
export function normalizeQuestionContent(
  input: QuestionContentInput,
  options: { conceptVocabulary?: ReadonlySet<string> } = {},
): NormalizedQuestionContent {
  if (!isObject(input)) return bad('Invalid question');
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000)
    bad('Invalid prompt');
  const responseType = input.responseType;
  if (!QUESTION_RESPONSE_TYPES.includes(responseType))
    bad('Invalid response type');
  if (!QUESTION_PROVENANCES.includes(input.provenance))
    bad('Invalid provenance');

  const hasChoices = ['multiple-choice', 'multi-select'].includes(responseType);
  const choices = (input.choices ?? []) as QuestionChoice[];
  if (!Array.isArray(choices) || choices.length > 50) bad('Invalid choices');
  if (hasChoices ? choices.length < 2 : choices.length)
    bad(
      hasChoices
        ? 'Choice questions need at least two choices'
        : 'Choices are only for choice questions',
    );
  const normalizedChoices = choices.map((c) => {
    if (!isObject(c)) return bad('Invalid choice');
    onlyKeys(c, ['id', 'label'], 'choice');
    if (
      typeof c.id !== 'string' ||
      !ID.test(c.id) ||
      typeof c.label !== 'string' ||
      !c.label.trim() ||
      c.label.length > 2000
    )
      bad('Invalid choice');
    return { id: c.id as string, label: c.label as string };
  });
  unique(
    normalizedChoices.map((c) => c.id),
    'choice id',
  );

  const parts = (input.subparts ?? []) as QuestionSubpart[];
  if (!Array.isArray(parts) || parts.length > 50) bad('Invalid subparts');
  if (responseType === 'multi-part' ? !parts.length : parts.length)
    bad('Subparts are required for, and only for, multi-part questions');
  const subparts = parts.map((p): QuestionSubpart => {
    if (!isObject(p)) return bad('Invalid subpart');
    onlyKeys(
      p,
      ['partKey', 'prompt', 'responseType', 'pointsPossible'],
      'subpart',
    );
    if (
      typeof p.partKey !== 'string' ||
      !ID.test(p.partKey) ||
      typeof p.prompt !== 'string' ||
      !p.prompt.trim() ||
      p.prompt.length > 20_000 ||
      (p.responseType !== undefined &&
        (!QUESTION_RESPONSE_TYPES.includes(
          p.responseType as QuestionResponseType,
        ) ||
          ['multi-part', 'multiple-choice', 'multi-select'].includes(
            p.responseType as string,
          ))) ||
      (p.pointsPossible !== undefined &&
        (typeof p.pointsPossible !== 'number' ||
          !Number.isFinite(p.pointsPossible) ||
          p.pointsPossible <= 0))
    )
      bad('Invalid subpart');
    return {
      partKey: p.partKey as string,
      prompt: p.prompt as string,
      ...(p.responseType
        ? { responseType: p.responseType as QuestionSubpart['responseType'] }
        : {}),
      ...(p.pointsPossible !== undefined
        ? { pointsPossible: p.pointsPossible as number }
        : {}),
    };
  });
  unique(
    subparts.map((p) => p.partKey),
    'subpart key',
  );

  const mediaIn = (input.media ?? []) as QuestionMediaRef[];
  if (!Array.isArray(mediaIn) || mediaIn.length > 20) bad('Invalid media');
  const media = mediaIn.map((m) => {
    if (!isObject(m)) return bad('Invalid media');
    onlyKeys(m, ['assetId', 'role', 'alt'], 'media');
    if (
      typeof m.assetId !== 'string' ||
      !m.assetId ||
      m.assetId.length > 200 ||
      (m.role !== undefined &&
        !['figure', 'passage', 'audio', 'other'].includes(m.role as string)) ||
      (m.alt !== undefined && (typeof m.alt !== 'string' || m.alt.length > 500))
    )
      bad('Invalid media');
    return {
      assetId: m.assetId as string,
      role: (m.role ?? 'other') as Required<QuestionMediaRef>['role'],
      alt: (m.alt ?? '') as string,
    };
  });

  const objectiveIds = unique(
    strings(input.objectiveIds ?? [], 'objectives', 50, 200),
    'objective',
  );
  const conceptIds = unique(
    strings(input.conceptIds ?? [], 'concepts', 50, 200),
    'concept',
  );
  for (const id of conceptIds)
    if (
      !CONCEPT.test(id) ||
      (options.conceptVocabulary && !options.conceptVocabulary.has(id))
    )
      bad('Unknown concept');

  let answerKey: QuestionAnswerKey | null = null;
  if (input.answerKey !== undefined && input.answerKey !== null) {
    const key = input.answerKey as unknown;
    if (!isObject(key)) return bad('Invalid answer key');
    onlyKeys(
      key,
      [
        'correctChoiceIds',
        'acceptedAnswers',
        'numeric',
        'parts',
        'explanation',
      ],
      'answer key',
    );
    const choiceIds = hasChoices
      ? new Set(normalizedChoices.map((c) => c.id))
      : null;
    const { parts: keyParts, explanation, ...rest } = key;
    const normalized: QuestionAnswerKey = Object.keys(rest).length
      ? atom(rest, choiceIds, 'answer key')
      : {};
    if (keyParts !== undefined) {
      if (!isObject(keyParts) || !Object.keys(keyParts).length)
        return bad('Invalid answer key parts');
      const known = new Set(subparts.map((p) => p.partKey));
      normalized.parts = Object.fromEntries(
        Object.entries(keyParts).map(([partKey, value]) => {
          if (!known.has(partKey)) bad('Answer key names an unknown subpart');
          return [partKey, atom(value, null, 'answer key part')];
        }),
      );
    }
    if (explanation !== undefined) {
      if (
        typeof explanation !== 'string' ||
        !explanation.trim() ||
        explanation.length > 5000
      )
        bad('Invalid answer explanation');
      normalized.explanation = explanation as string;
    }
    if (
      !normalized.correctChoiceIds &&
      !normalized.acceptedAnswers &&
      !normalized.numeric &&
      !normalized.parts
    )
      bad('An answer key cannot be empty; omit it when unknown');
    if (
      responseType === 'multiple-choice' &&
      normalized.correctChoiceIds &&
      normalized.correctChoiceIds.length !== 1
    )
      bad('A multiple-choice key names exactly one choice');
    answerKey = normalized;
  }

  let rubric: QuestionRubric | null = null;
  if (input.rubric !== undefined && input.rubric !== null) {
    try {
      rubric = parseQuestionRubric(input.rubric);
    } catch (error) {
      bad((error as Error).message);
    }
  }
  let pointsPossible: number | null = null;
  if (input.pointsPossible !== undefined && input.pointsPossible !== null) {
    if (
      typeof input.pointsPossible !== 'number' ||
      !Number.isFinite(input.pointsPossible) ||
      input.pointsPossible <= 0
    )
      bad('Invalid points possible');
    pointsPossible = input.pointsPossible;
  }
  if (
    rubric &&
    pointsPossible !== null &&
    rubric.criteria.reduce((s, c) => s + c.maxPoints, 0) !== pointsPossible
  )
    bad('Points possible must equal the rubric total');

  const present: Record<QuestionField, boolean> = {
    prompt: true,
    responseType: true,
    choices: normalizedChoices.length > 0,
    subparts: subparts.length > 0,
    media: media.length > 0,
    objectives: objectiveIds.length > 0,
    concepts: conceptIds.length > 0,
    answerKey: answerKey !== null,
    rubric: rubric !== null,
    pointsPossible: pointsPossible !== null,
  };
  const explicit = input.fieldProvenance ?? {};
  if (!isObject(explicit)) return bad('Invalid field provenance');
  const fieldProvenance: Partial<Record<QuestionField, QuestionProvenance>> =
    {};
  for (const [field, value] of Object.entries(explicit))
    if (
      !QUESTION_FIELDS.includes(field as QuestionField) ||
      !QUESTION_PROVENANCES.includes(value as QuestionProvenance) ||
      !present[field as QuestionField]
    )
      bad('Provenance may only describe a present field');
  for (const field of QUESTION_FIELDS)
    if (present[field])
      fieldProvenance[field] =
        (explicit as Partial<Record<QuestionField, QuestionProvenance>>)[
          field
        ] ?? input.provenance;

  return {
    prompt: prompt as string,
    responseType,
    choices: normalizedChoices,
    subparts,
    media,
    objectiveIds,
    conceptIds,
    answerKey,
    rubric,
    pointsPossible,
    provenance: input.provenance,
    fieldProvenance,
  };
}

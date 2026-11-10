/**
 * Structured questions: an assistant turn that asks the person to choose,
 * rendered as a small form instead of a prose list (#4100).
 *
 * The shape mirrors MCP elicitation (a prompt plus schema-driven fields) but
 * keeps to what a chat can render accessibly: choice fields, single or
 * multiple, with options and an optional default. A transport attaches one to
 * an assistant message's `toolCallData` (alone or inside an array):
 *
 * ```ts
 * { kind: 'assistant-question', id: 'q1', prompt: 'Group invoices by…',
 *   fields: [{ name: 'groupBy', label: 'Group by', type: 'choice',
 *     options: [{ value: 'issueDate:month', label: 'Issue date by month' }],
 *     default: 'issueDate:month' }] }
 * ```
 *
 * `AssistantDock` renders it with `AssistantQuestionForm`. Submitting calls the
 * transport's `answerQuestion` (the transport continues in code, no model
 * round-trip) or, without one, sends the answer as an ordinary message
 * (`describeAssistantQuestionAnswer`). A typed reply still works:
 * `matchAssistantQuestionText` resolves free text against the options. The
 * options always come from code that knows the domain, never a model's prose.
 * Pure and rune-free: safe in any host.
 */

export const ASSISTANT_QUESTION_KIND = 'assistant-question';

const MAX_FIELDS = 6;
const MAX_OPTIONS = 50;
const MAX_TEXT = 200;
const MAX_KEYWORDS = 12;

export interface AssistantQuestionOption {
  /** Stable value submitted for this option. */
  value: string;
  /** Short plain label. */
  label: string;
  /** One optional plain line under the label. */
  hint?: string;
  /** Extra words a typed answer may use for it ("monthly", "per month"). */
  keywords?: string[];
}

export interface AssistantQuestionField {
  name: string;
  label: string;
  type: 'choice';
  options: AssistantQuestionOption[];
  /** Several options may be chosen (checkboxes). */
  multiple?: boolean;
  /** Preselected value(s); must be option values. */
  default?: string | string[];
  required?: boolean;
}

/** Submitted values by field name. */
export type AssistantQuestionAnswer = Record<string, string | string[]>;

export interface AssistantQuestion {
  kind: typeof ASSISTANT_QUESTION_KIND;
  /** Stable within the conversation. */
  id: string;
  /** The question, used as the form's legend. */
  prompt: string;
  fields: AssistantQuestionField[];
  submitLabel?: string;
  /** Present once answered: the form renders as a read-only summary. */
  answer?: AssistantQuestionAnswer;
}

/** Input to `AssistantTransport.answerQuestion`. */
export interface AssistantAnswerQuestionInput {
  threadId: string;
  /** The assistant message the question rode on. */
  messageId: string;
  questionId: string;
  values: AssistantQuestionAnswer;
  clientRequestId: string;
}

const text = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === 'string' && value.trim() && value.trim().length <= max
    ? value.trim()
    : undefined;

function parseOption(value: unknown): AssistantQuestionOption | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const optionValue = text(raw.value);
  const label = text(raw.label);
  if (!optionValue || !label) return null;
  const hint = text(raw.hint);
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.flatMap((k) => text(k, 60) ?? []).slice(0, MAX_KEYWORDS)
    : [];
  return {
    value: optionValue,
    label,
    ...(hint ? { hint } : {}),
    ...(keywords.length ? { keywords } : {}),
  };
}

function parseField(value: unknown): AssistantQuestionField | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = text(raw.name, 64);
  const label = text(raw.label);
  if (!name || !label || raw.type !== 'choice' || !Array.isArray(raw.options)) {
    return null;
  }
  const options = raw.options
    .slice(0, MAX_OPTIONS)
    .flatMap((o) => parseOption(o) ?? []);
  const values = new Set(options.map((o) => o.value));
  if (options.length === 0 || values.size !== options.length) return null;
  const multiple = raw.multiple === true;
  const defaults = (
    Array.isArray(raw.default) ? raw.default : [raw.default]
  ).filter((v): v is string => typeof v === 'string' && values.has(v));
  return {
    name,
    label,
    type: 'choice',
    options,
    ...(multiple ? { multiple } : {}),
    ...(defaults.length ? { default: multiple ? defaults : defaults[0] } : {}),
    ...(raw.required === true ? { required: true } : {}),
  };
}

/** Validate untrusted question data; null when it is not a usable question. */
export function parseAssistantQuestion(
  value: unknown,
): AssistantQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== ASSISTANT_QUESTION_KIND) return null;
  const id = text(raw.id, 120);
  const prompt = text(raw.prompt, 500);
  if (!id || !prompt || !Array.isArray(raw.fields)) return null;
  const fields = raw.fields
    .slice(0, MAX_FIELDS)
    .flatMap((f) => parseField(f) ?? []);
  if (fields.length === 0) return null;
  const submitLabel = text(raw.submitLabel, 60);
  const question: AssistantQuestion = {
    kind: ASSISTANT_QUESTION_KIND,
    id,
    prompt,
    fields,
    ...(submitLabel ? { submitLabel } : {}),
  };
  const answer = validateAssistantQuestionAnswer(question, raw.answer);
  return answer ? { ...question, answer } : question;
}

/** The question a message carries in `toolCallData` (alone or in an array). */
export function assistantQuestionFromMessage(message: {
  toolCallData?: unknown;
}): AssistantQuestion | null {
  const data = message.toolCallData;
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    const question = parseAssistantQuestion(item);
    if (question) return question;
  }
  return null;
}

/** Each field's default (the first option for a required single choice). */
export function assistantQuestionDefaults(
  question: AssistantQuestion,
): AssistantQuestionAnswer {
  const out: AssistantQuestionAnswer = {};
  for (const field of question.fields) {
    if (field.default !== undefined) out[field.name] = field.default;
    else if (!field.multiple && field.required) {
      out[field.name] = field.options[0].value;
    }
  }
  return out;
}

/** Keep only known fields and option values; null when nothing is left. */
export function validateAssistantQuestionAnswer(
  question: AssistantQuestion,
  values: unknown,
): AssistantQuestionAnswer | null {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return null;
  }
  const raw = values as Record<string, unknown>;
  const out: AssistantQuestionAnswer = {};
  for (const field of question.fields) {
    const allowed = new Set(field.options.map((o) => o.value));
    const given = raw[field.name];
    const picked = (Array.isArray(given) ? given : [given]).filter(
      (v): v is string => typeof v === 'string' && allowed.has(v),
    );
    if (picked.length === 0) continue;
    out[field.name] = field.multiple ? [...new Set(picked)] : picked[0];
  }
  return Object.keys(out).length ? out : null;
}

/** "Group by: Issue date by month" — the answer as one plain line. */
export function describeAssistantQuestionAnswer(
  question: AssistantQuestion,
  values: AssistantQuestionAnswer,
): string {
  return question.fields
    .flatMap((field) => {
      const chosen = values[field.name];
      if (chosen === undefined) return [];
      const labels = (Array.isArray(chosen) ? chosen : [chosen]).map(
        (v) => field.options.find((o) => o.value === v)?.label ?? v,
      );
      return labels.length ? [`${field.label}: ${labels.join(', ')}`] : [];
    })
    .join('; ');
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'by',
  'per',
  'of',
  'in',
  'on',
  'for',
  'to',
  'with',
  'please',
  'use',
  'i',
  'want',
  'it',
  'its',
  'group',
  'grouped',
  'show',
  'me',
]);

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/**
 * Resolve a typed reply against the options: per field, the option sharing
 * the most words with the reply (label, value, hint, keywords; plurals and
 * filler words ignored), the earlier option on a tie, so a ranked list's
 * best guess wins. Null when the reply matches no option of any field.
 */
export function matchAssistantQuestionText(
  question: AssistantQuestion,
  reply: string,
): AssistantQuestionAnswer | null {
  const said = new Set(words(reply));
  if (said.size === 0) return null;
  const out: AssistantQuestionAnswer = {};
  for (const field of question.fields) {
    let best: { value: string; score: number } | null = null;
    for (const option of field.options) {
      const vocabulary = new Set(
        words(
          [
            option.label,
            option.value,
            option.hint ?? '',
            ...(option.keywords ?? []),
          ].join(' '),
        ),
      );
      let score = 0;
      for (const word of said) if (vocabulary.has(word)) score += 1;
      if (score > 0 && (!best || score > best.score)) {
        best = { value: option.value, score };
      }
    }
    if (best) out[field.name] = field.multiple ? [best.value] : best.value;
  }
  return Object.keys(out).length ? out : null;
}

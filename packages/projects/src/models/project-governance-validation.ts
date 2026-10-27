import type {
  ProjectContextReference,
  ProjectDecisionOption,
  ProjectQuestionOption,
} from '../project-governance-types.js';

const CONTEXT_KINDS = new Set([
  'spec',
  'cookbook',
  'conversation',
  'asset',
  'url',
  'other',
]);

export function parseContextReferences(
  value: string,
): ProjectContextReference[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('Project context references must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length > 100)
    throw new TypeError(
      'Project context references must be an array of at most 100 items.',
    );
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object')
      throw new TypeError('Invalid project context reference.');
    const item = entry as Record<string, unknown>;
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
    const label =
      typeof item.label === 'string' ? item.label.trim() : undefined;
    if (!CONTEXT_KINDS.has(kind) || !ref)
      throw new TypeError('Invalid project context reference.');
    return {
      kind,
      ref,
      ...(label ? { label } : {}),
    } as ProjectContextReference;
  });
}

export function serializeContextReferences(
  value: readonly ProjectContextReference[],
): string {
  return JSON.stringify(parseContextReferences(JSON.stringify(value)));
}

export function parseDecisionOptions(value: string): ProjectDecisionOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('Project decision options must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length > 50)
    throw new TypeError(
      'Project decision options must be an array of at most 50 items.',
    );
  const seen = new Set<string>();
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object')
      throw new TypeError('Invalid project decision option.');
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const description =
      typeof item.description === 'string'
        ? item.description.trim()
        : undefined;
    if (!id || !label || seen.has(id))
      throw new TypeError(
        'Project decision option ids and labels must be unique and non-empty.',
      );
    seen.add(id);
    return { id, label, ...(description ? { description } : {}) };
  });
}

export function serializeDecisionOptions(
  value: readonly ProjectDecisionOption[],
): string {
  return JSON.stringify(parseDecisionOptions(JSON.stringify(value)));
}

/** Normalize authored choices; the reserved Other entry is never caller-authored. */
export function parseQuestionOptions(value: string): ProjectQuestionOption[] {
  const options = parseDecisionOptions(value);
  const raw = JSON.parse(value) as Record<string, unknown>[];
  return options.map((option, index) => {
    if (option.id.toLowerCase() === 'other')
      throw new TypeError('Project question option id "other" is reserved.');
    if (
      raw[index].recommended !== undefined &&
      typeof raw[index].recommended !== 'boolean'
    )
      throw new TypeError(
        'Project question option recommended must be boolean.',
      );
    if (
      raw[index].description !== undefined &&
      typeof raw[index].description !== 'string'
    )
      throw new TypeError('Project question option description must be text.');
    return {
      ...option,
      ...(raw[index].recommended === undefined
        ? {}
        : { recommended: raw[index].recommended as boolean }),
    };
  });
}

export function serializeQuestionOptions(
  value: readonly ProjectQuestionOption[],
): string {
  return JSON.stringify(parseQuestionOptions(JSON.stringify(value)));
}

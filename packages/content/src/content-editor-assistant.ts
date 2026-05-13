export type ContentEditorAssistantEditorKind = 'content' | 'governed';

export type ContentEditorAssistantFieldValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type ContentEditorAssistantFields = Record<
  string,
  ContentEditorAssistantFieldValue
>;

const TEXT_FIELD_KEYS = new Set(['title', 'description', 'body']);
const ENUM_FIELD_VALUES: Record<string, Set<string>> = {
  type: new Set(['article', 'document', 'mirror']),
  status: new Set(['draft', 'published', 'archived']),
  state: new Set(['active', 'highlighted', 'deprecated']),
};

export interface ContentEditorAssistantGovernanceSummary {
  reviewProfileKey?: string | null;
  enforcePublishReadiness?: boolean;
  publishReadiness?: {
    level?: string;
    title?: string;
    message?: string;
    disableSave?: boolean;
    details?: string[];
  } | null;
}

export interface ContentEditorAssistantFactSummary {
  factIds?: string[];
  factCount?: number;
}

export interface ContentEditorAssistantContextData {
  contentId: string;
  contentType: string;
  editorKind: ContentEditorAssistantEditorKind;
  fields: ContentEditorAssistantFields;
  currentEditorState: string;
  referenceIds: string[];
  facts?: ContentEditorAssistantFactSummary;
  governance?: ContentEditorAssistantGovernanceSummary | null;
}

export interface ContentEditorAssistantContext {
  type: 'content.editor';
  title: string | null;
  data: ContentEditorAssistantContextData;
}

export interface ContentEditorAssistantActions {
  triggerSave: () => void;
  triggerReview?: (kind: string) => void | Promise<void>;
  applyFieldUpdates: (fields: Record<string, string>) => void;
  undoLastFieldUpdate?: () => void;
}

export interface ContentEditorAssistantRegistration {
  context: ContentEditorAssistantContext;
  actions: ContentEditorAssistantActions;
}

export type ContentEditorAssistantContextChange = (
  registration: ContentEditorAssistantRegistration | null,
) => void;

export interface CreateContentEditorAssistantContextInput {
  contentId: string;
  title?: string | null;
  editorKind?: ContentEditorAssistantEditorKind;
  fields?: ContentEditorAssistantFields | null;
  currentEditorState?: string | null;
  referenceIds?: unknown;
  facts?: ContentEditorAssistantFactSummary | null;
  governance?: ContentEditorAssistantGovernanceSummary | null;
}

export interface ContentEditorAssistantChatProps {
  contentId: string;
  currentEditorState: string;
  currentReferenceIds: string[];
  formFields: Record<string, string>;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function normalizeReferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = normalizeString(item).trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeChatFields(
  fields: ContentEditorAssistantFields | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields ?? {}).map(([key, value]) => [
      key,
      normalizeString(value),
    ]),
  );
}

export function sanitizeContentEditorAssistantFieldUpdates(
  fields: unknown,
): Record<string, string> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }

  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (TEXT_FIELD_KEYS.has(key)) {
      updates[key] = normalizeString(value);
      continue;
    }

    const enumValues = ENUM_FIELD_VALUES[key];
    if (!enumValues) {
      continue;
    }

    const normalizedValue = normalizeString(value).trim();
    if (enumValues.has(normalizedValue)) {
      updates[key] = normalizedValue;
    }
  }

  return updates;
}

export function createContentEditorAssistantContext(
  input: CreateContentEditorAssistantContextInput,
): ContentEditorAssistantContext {
  const fields = input.fields ?? {};
  const contentType = normalizeString(fields.type).trim() || 'content';
  const title = input.title ?? (normalizeString(fields.title).trim() || null);

  return {
    type: 'content.editor',
    title,
    data: {
      contentId: input.contentId,
      contentType,
      editorKind: input.editorKind ?? 'content',
      fields,
      currentEditorState:
        input.currentEditorState ?? normalizeString(fields.body),
      referenceIds: normalizeReferenceIds(input.referenceIds),
      ...(input.facts ? { facts: input.facts } : {}),
      ...(input.governance !== undefined
        ? { governance: input.governance }
        : {}),
    },
  };
}

export function contentEditorAssistantContextToChatProps(
  context: ContentEditorAssistantContext,
): ContentEditorAssistantChatProps {
  return {
    contentId: context.data.contentId,
    currentEditorState: context.data.currentEditorState,
    currentReferenceIds: [...context.data.referenceIds],
    formFields: normalizeChatFields(context.data.fields),
  };
}

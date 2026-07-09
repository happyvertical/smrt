/**
 * Persona ↔ prompt-override binding (#1889).
 *
 * A persona's `instructions` are applied to the running agent through a
 * **tenant/persona-scoped `prompt_override`**, not by mutating the agent's code
 * default. Each persona owns a dedicated, per-persona prompt key registered at
 * runtime with a neutral empty base template; the persona's actual instructions
 * live entirely in the override layer. Because the key is unique per persona,
 * two personas of the same tenant and agent class resolve to different
 * instructions without colliding on the `(key, context)` override identity.
 *
 * Activating a directive (see {@link DirectiveApprovalService}) is exactly the
 * act of writing/updating this override — and it flows through
 * `PromptOverride.save()`, so `validatePromptOverride` still forbids overriding
 * a non-editable prompt field.
 *
 * @module
 */

import {
  definePrompt,
  type PromptDefinition,
  type PromptEditableConfig,
  type PromptOverride,
  PromptOverrideCollection,
  PromptRegistry,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';

/** The minimal persona shape these helpers need. */
export interface PersonaLike {
  id?: string | null;
  tenantId?: string | null;
  instructions?: string;
}

/**
 * The registered prompt key a persona's instructions map to.
 *
 * @throws if the persona has no id (an unsaved persona has no stable key).
 */
export function personaInstructionsPromptKey(persona: PersonaLike): string {
  const id = persona.id;
  if (!id) {
    throw new Error(
      'personaInstructionsPromptKey requires a persisted persona (missing id)',
    );
  }
  return `persona.${id}.instructions`;
}

/** Default editability for a persona instructions prompt: template-only. */
const DEFAULT_PERSONA_EDITABLE: PromptEditableConfig = {
  template: true,
  profile: false,
  model: false,
  params: false,
};

/**
 * Idempotently register the per-persona instructions prompt.
 *
 * The base template is always the empty string and the editability is fixed, so
 * repeated calls register an identical definition (the registry is idempotent
 * for matching definitions). The persona's real instructions are supplied by
 * the override layer, never by the base template — that keeps re-registration
 * stable even as instructions change.
 *
 * Pass `editable` to model a prompt whose template is locked; activation of a
 * proposal against such a key is then rejected by `validatePromptOverride`.
 */
export function ensurePersonaInstructionsPrompt(
  persona: PersonaLike,
  options: { editable?: Partial<PromptEditableConfig> } = {},
): PromptDefinition {
  const key = personaInstructionsPromptKey(persona);
  const existing = PromptRegistry.get(key);
  // Fast path only when the caller does not assert a specific editability. When
  // `editable` IS given, always go through definePrompt so a conflicting
  // re-registration (e.g. trying to lock `template: false` over an already
  // editable key) is rejected loudly rather than silently ignored.
  if (existing && options.editable === undefined) {
    return existing;
  }
  return definePrompt({
    key,
    template: '',
    editable: { ...DEFAULT_PERSONA_EDITABLE, ...(options.editable ?? {}) },
  });
}

/**
 * Upsert a scoped `prompt_override` template for a registered prompt key.
 *
 * Loads the existing app/tenant override (by `tenantId`), updates its template,
 * or creates a new one. Always flows through `PromptOverride.save()`, so
 * `validatePromptOverride` still forbids overriding a non-editable template.
 *
 * The prompt key must already be registered (via
 * {@link ensurePersonaInstructionsPrompt} or `definePrompt`); this helper does
 * not register it, so it never silently relaxes a locked prompt's editability.
 *
 * @returns The persisted override.
 */
export async function upsertPromptTemplateOverride(options: {
  db: DatabaseInterface;
  key: string;
  tenantId: string | null;
  template: string;
}): Promise<PromptOverride> {
  const { db, key, tenantId, template } = options;
  const overrides = await PromptOverrideCollection.create({ db });
  const existing =
    tenantId != null
      ? await overrides.getTenantOverride(key, tenantId)
      : await overrides.getAppOverride(key);

  if (existing) {
    existing.template = template;
    await existing.save();
    return existing;
  }

  return overrides.create({ key, tenantId, template });
}

/**
 * Write (or update) the tenant-scoped `prompt_override` that carries a persona's
 * instructions.
 *
 * Ensures the per-persona prompt key is registered, then upserts the override
 * template to `instructions ?? persona.instructions`. Flows through
 * `PromptOverride.save()`, so a non-editable template throws.
 *
 * @returns The persisted override.
 */
export async function applyPersonaInstructions(options: {
  persona: PersonaLike;
  db: DatabaseInterface;
  instructions?: string;
  editable?: Partial<PromptEditableConfig>;
}): Promise<PromptOverride> {
  const { persona, db } = options;
  ensurePersonaInstructionsPrompt(persona, { editable: options.editable });
  return upsertPromptTemplateOverride({
    db,
    key: personaInstructionsPromptKey(persona),
    tenantId: persona.tenantId ?? null,
    template: options.instructions ?? persona.instructions ?? '',
  });
}

/**
 * Resolve a persona's effective instructions through the prompt system —
 * layering code default → config → app override → tenant (persona) override.
 *
 * @returns The rendered instructions text (empty string when nothing overrides
 *   the neutral base template).
 */
export async function resolvePersonaInstructions(options: {
  persona: PersonaLike;
  db: DatabaseInterface;
  variables?: Record<string, unknown>;
}): Promise<string> {
  const { persona, db } = options;
  ensurePersonaInstructionsPrompt(persona);
  const key = personaInstructionsPromptKey(persona);
  const resolved = await resolvePrompt(key, {
    db,
    tenantId: persona.tenantId ?? null,
    variables: options.variables,
  });
  return resolved.text;
}

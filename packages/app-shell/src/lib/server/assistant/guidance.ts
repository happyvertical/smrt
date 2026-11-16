// The packaged system prompt. Bundled as a string (Vite `?raw`), so a built
// server needs no file beside it.
import {
  definePrompt,
  type ResolvedPrompt,
  type ResolvePromptOptions,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import guidance from '../../assistant/guidance/system.md?raw';
import { LIVE_MODE, type ModeContext } from './scope.ts';

/** The registered key of the assistant's system prompt (#5005). */
export const ASSISTANT_PROMPT_KEY = 'app-shell.assistant.system';

/** The run definition key of one assistant turn (#5005). */
export const ASSISTANT_TURN_DEFINITION_KEY = 'app-shell.assistant.turn';

/**
 * The assistant's system guidance, registered so an app or tenant can layer
 * an override over the packaged text. The mode line is not part of it: it
 * changes with the turn and is appended by {@link composeSystemPrompt}. The
 * prompt declares the tier the assistant asks for (`good`); the owner's
 * `SMRT_APP_SHELL_ASSISTANT_TIER` setting overrides it where the model is built.
 */
export const assistantSystemPrompt = definePrompt({
  key: ASSISTANT_PROMPT_KEY,
  template: guidance.trim(),
  ai: { profile: 'good' },
  editable: { template: true, profile: false, model: false, params: false },
});

/** The one line that tells the model which copy it is working on right now. */
export function modeLine(mode: ModeContext): string {
  if (!mode.draft)
    return 'Mode: no draft is open. Changes you make to the structure go to the live app, and risky ones wait for the person to approve. If the person wants to try changes safely first, you can start a draft with app_startdraft.';
  const head = `Mode: the draft "${mode.draft}" is open. You build only in the draft; the live app's structure is frozen. After any structural change, say plainly that you changed the draft and that the live app is unchanged.`;
  if (mode.scope.records === 'draft')
    return `${head} The person is looking at the DRAFT, so the records you list, create or change are the draft's test records (they are thrown away when the draft is published).`;
  return `${head} The person is looking at the LIVE app, so the records you list, create or change are the real ones. New models and fields exist only in the draft; to try them with records the person must switch the view to Draft. To make the draft's changes live, call app_publishdraft: it waits for the person's approval and never applies by itself.`;
}

/** The packaged guidance text, before any layer is applied. */
export function packagedGuidance(): string {
  return guidance;
}

/** `guidance` with the mode line for `mode`: what the model is told. */
export function composeSystemPrompt(
  text: string,
  mode: ModeContext = LIVE_MODE,
): string {
  return `${text.trim()}\n\n## Where you are working right now\n\n${modeLine(mode)}`;
}

/** The system prompt every assistant turn starts from, with the mode line for `mode`. */
export function systemPrompt(mode: ModeContext = LIVE_MODE): string {
  return composeSystemPrompt(guidance, mode);
}

/**
 * The assistant prompt as this tenant sees it: the packaged text, config and
 * stored app and tenant overrides, resolved through `resolvePrompt`. A
 * database that cannot hold overrides resolves the layers that need none.
 */
export async function resolveAssistantPrompt(
  options: Pick<ResolvePromptOptions, 'db' | 'tenantId'> = {},
): Promise<ResolvedPrompt> {
  try {
    return await resolvePrompt(ASSISTANT_PROMPT_KEY, options);
  } catch (error) {
    if (!options.db) throw error;
    return resolvePrompt(ASSISTANT_PROMPT_KEY, {
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    });
  }
}

/** Current app state travels on every turn, including resumed CLI sessions.
 * Keep this transient: the stored conversation remains the person's words.
 */
export function turnInput(text: string, mode: ModeContext): string {
  return `${text}\n\n<app-context>\n${modeLine(mode)}\n</app-context>`;
}

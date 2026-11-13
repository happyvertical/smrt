// The packaged system prompt. Bundled as a string (Vite `?raw`), so a built
// server needs no file beside it.
import guidance from '../../assistant/guidance/system.md?raw';
import { LIVE_MODE, type ModeContext } from './scope.ts';

/** The one line that tells the model which copy it is working on right now. */
export function modeLine(mode: ModeContext): string {
  if (!mode.draft)
    return 'Mode: no draft is open. Changes you make to the structure go to the live app, and risky ones wait for the person to approve. If the person wants to try changes safely first, you can start a draft with app_startdraft.';
  const head = `Mode: the draft "${mode.draft}" is open. You build only in the draft; the live app's structure is frozen. After any structural change, say plainly that you changed the draft and that the live app is unchanged.`;
  if (mode.scope.records === 'draft')
    return `${head} The person is looking at the DRAFT, so the records you list, create or change are the draft's test records (they are thrown away when the draft is published).`;
  return `${head} The person is looking at the LIVE app, so the records you list, create or change are the real ones. New models and fields exist only in the draft; to try them with records the person must switch the view to Draft. To make the draft's changes live, call app_publishdraft: it waits for the person's approval and never applies by itself.`;
}

/** The system prompt every assistant turn starts from, with the mode line for `mode`. */
export function systemPrompt(mode: ModeContext = LIVE_MODE): string {
  return `${guidance.trim()}\n\n## Where you are working right now\n\n${modeLine(mode)}`;
}

/** Current app state travels on every turn, including resumed CLI sessions.
 * Keep this transient: the stored conversation remains the person's words.
 */
export function turnInput(text: string, mode: ModeContext): string {
  return `${text}\n\n<app-context>\n${modeLine(mode)}\n</app-context>`;
}

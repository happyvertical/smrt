// The packaged system prompt. Bundled as a string (Vite `?raw`), so a built
// server needs no file beside it.
import guidance from '../../assistant/guidance/system.md?raw';

/** The system prompt every assistant turn starts from. */
export function systemPrompt(): string {
  return guidance.trim();
}

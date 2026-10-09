/**
 * A speech source for smrt-ui's `Dictation` (the microphone button and
 * "press and hold a field to speak" in `@happyvertical/smrt-ui/forms`).
 *
 * `STTAdapter` already has the shape `Dictation` needs (`start`, `stop`,
 * `onResult`, `onError`, `onStart`, `onEnd`), so this only creates the
 * adapter lazily, once, the first time someone starts dictating: nothing
 * loads and no microphone prompt appears until then. Defaults to the
 * browser's own speech recognition (`browser-speech`), which needs no
 * download; an on-device model is never downloaded by dictation (see
 * `LocalSpeechSTTAdapter.prepare`). An unsupported browser rejects with
 * `CapabilityNotAvailableError`, which `Dictation` reports in plain words.
 *
 * @example
 * ```svelte
 * <script>
 *   import { createSttDictationSource } from '@happyvertical/smrt-svelte/browser-ai';
 *   import { Dictation, DictationButton } from '@happyvertical/smrt-ui/forms';
 *   const dictation = new Dictation({ source: createSttDictationSource(), onText: (t) => … });
 * </script>
 * <DictationButton {dictation} />
 * ```
 */
import { getSTT } from './factory.js';
import type { GetSTTOptions, STTAdapter } from './types.js';

export function createSttDictationSource(
  options: GetSTTOptions = { type: 'browser-speech' },
): () => Promise<STTAdapter> {
  let adapter: Promise<STTAdapter> | null = null;
  return () => {
    adapter ??= (async () => {
      const created = await getSTT(options);
      // An adapter that needs a download is never loaded here: dictation must
      // not start one. It checks its own model when started, and the host
      // loads it explicitly (after asking).
      if (!created.getCapabilities().requiresDownload) {
        await created.ensureInitialized();
      }
      return created;
    })().catch((error: unknown) => {
      // Let a later tap try again (for example after a permission change).
      adapter = null;
      throw error;
    });
    return adapter;
  };
}

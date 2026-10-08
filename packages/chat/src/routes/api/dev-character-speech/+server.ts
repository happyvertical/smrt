import { getSpeechSynthesizer } from '@happyvertical/speech';
import { error, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { openDevHelperService } from '../../../dev-helper-server.js';
import { resolveDevAIConfig } from '../dev-ai.js';
import {
  isLocalDevCharacterRequest,
  resolveDevCharacterPersistenceConfig,
} from '../dev-character-persistence/config.js';

const MAX_TEXT_LENGTH = 500;
const MAX_REQUEST_BYTES = 2048;
const OPENAI_AUDIO_URL = 'https://api.openai.com/v1';

async function readJsonBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        error(413, 'Speech request is too large.');
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (request.signal.aborted) error(499, 'Speech cancelled.');
    throw cause;
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  if (!isLocalDevCharacterRequest({ dev, request, getClientAddress }))
    error(404, 'Not found.');
  if (request.signal.aborted) error(499, 'Speech cancelled.');
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES)
    error(413, 'Speech request is too large.');
  const body = (await readJsonBody(request)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_TEXT_LENGTH)
    error(400, `Speech text must be 1-${MAX_TEXT_LENGTH} characters.`);
  // The browser submits only text. When helper persistence is configured, the
  // current effective voice is resolved afresh from its server-side policy.
  // A client cannot select a provider, URL, credential, or arbitrary voice.
  let voice = 'marin';
  const helperConfig = resolveDevCharacterPersistenceConfig();
  if (helperConfig) {
    const helper = await openDevHelperService(helperConfig);
    try {
      const snapshot = await helper.service.load(helper.context);
      if (!snapshot.preferences) error(503, 'Helper voice is unavailable.');
      voice = snapshot.preferences.voiceId;
    } finally {
      await helper.close();
    }
  }
  const config = resolveDevAIConfig();
  if (!config?.apiKey || config.provider !== 'openai')
    error(503, 'Local character speech needs a configured OpenAI provider.');
  try {
    const synthesizer = await getSpeechSynthesizer({
      type: 'openai-compatible',
      baseUrl: OPENAI_AUDIO_URL,
      apiKey: config.apiKey,
      defaultModel: 'gpt-4o-mini-tts',
      defaultVoice: voice,
    });
    const spoken = await synthesizer.synthesize({
      text,
      model: 'gpt-4o-mini-tts',
      voice,
      outputFormat: 'wav',
      signal: request.signal,
    });
    return new Response(spoken.audio, {
      headers: {
        'content-type': spoken.contentType,
        'cache-control': 'no-store',
      },
    });
  } catch (cause) {
    if (request.signal.aborted) error(499, 'Speech cancelled.');
    // Keep provider details and credentials server-side.
    error(
      502,
      cause instanceof Error
        ? 'Speech synthesis failed.'
        : 'Speech synthesis failed.',
    );
  }
};

import { type AIMessage, getAI } from '@happyvertical/ai';
import {
  createPhotoCutoutCoordinateGuide,
  faceOutlinePrompt,
  mouthLandmarksPrompt,
  parseFaceOutline,
  parseMouthLandmarks,
  parsePhotoCutoutSetup,
  photoCutoutSetupPrompt,
} from '@happyvertical/smrt-images';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { resolveDevAIConfig } from '../dev-ai.js';
import { isLocalDevCharacterRequest } from '../dev-character-persistence/config.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4);
const SOURCE_ID = 'source';
const OUTLINE_MAX_TOKENS = 8192;
const MOUTH_LANDMARKS_MAX_TOKENS = 4096;
const VISION_REASONING = { effort: 'low' as const, maxTokens: 1024 };

function rejectedReplyReason(reply: { truncated?: boolean }, cause: unknown) {
  if (reply.truncated) return 'model output was truncated at its token limit';
  return cause instanceof Error
    ? cause.message.replace(/[^a-zA-Z0-9 .:_-]/g, '').slice(0, 240)
    : 'invalid cutout geometry';
}

function requireCompleteReply(reply: { truncated?: boolean }) {
  if (reply.truncated)
    throw new Error('model output was truncated at its token limit');
}

function imagePayload(value: unknown): {
  dataUrl: string;
  width: number;
  height: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    error(400, 'A photo is required.');
  const body = value as Record<string, unknown>;
  if (
    typeof body.dataUrl !== 'string' ||
    !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      body.dataUrl,
    )
  )
    error(400, 'Use a PNG, JPEG, or WebP photo.');
  const width = body.width;
  const height = body.height;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 16_000_000
  )
    error(400, 'Photo dimensions are invalid.');
  const bytes = Math.floor(
    (body.dataUrl.length - body.dataUrl.indexOf(',') - 1) * 0.75,
  );
  if (bytes > MAX_IMAGE_BYTES)
    error(413, 'Photo is too large for character setup.');
  return { dataUrl: body.dataUrl, width, height };
}

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) error(400, 'A photo is required.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        error(413, 'Photo request is too large.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    error(400, 'Photo request must be valid JSON.');
  }
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  if (!isLocalDevCharacterRequest({ dev, request, getClientAddress }))
    error(404, 'Not found.');
  const config = resolveDevAIConfig();
  if (!config)
    error(
      503,
      'Photo setup is unavailable: configure a server-side AI provider.',
    );
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES)
    error(413, 'Photo request is too large.');
  const requestBody = await boundedJson(request);
  const image = imagePayload(requestBody);
  const ai = await getAI({
    type: config.provider,
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    defaultModel: config.model,
  } as never);
  try {
    if ((requestBody as Record<string, unknown>).stage === 'outline') {
      const guide = await createPhotoCutoutCoordinateGuide(
        image.dataUrl,
        image.width,
        image.height,
      );
      const messages: AIMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: faceOutlinePrompt() },
            {
              type: 'image_url',
              image_url: { url: image.dataUrl, detail: 'high' },
            },
            { type: 'image_url', image_url: { url: guide, detail: 'high' } },
          ],
        },
      ];
      const options = {
        model: config.model,
        maxTokens: OUTLINE_MAX_TOKENS,
        reasoning: VISION_REASONING,
        responseFormat: { type: 'json_object' as const },
        signal: request.signal,
      };
      const outline = await ai.chat(messages, options);
      try {
        requireCompleteReply(outline);
        return json({ outline: parseFaceOutline(outline.content) });
      } catch (cause) {
        if (request.signal.aborted) error(499, 'Photo setup cancelled.');
        const reason = rejectedReplyReason(outline, cause);
        // biome-ignore lint/suspicious/noConsole: server-only diagnostic excludes image, prompt, response, and configuration.
        console.info('[dev-character-setup] outline repair:', reason);
        const repair = await ai.chat(
          [
            ...messages,
            { role: 'assistant', content: outline.content },
            {
              role: 'user',
              content: `The outline was rejected: ${reason}. Return a complete repaired JSON outline only; tightly trace hair, ears and chin, with simple non-intersecting points.`,
            },
          ],
          options,
        );
        requireCompleteReply(repair);
        return json({ outline: parseFaceOutline(repair.content) });
      }
    }
    if ((requestBody as Record<string, unknown>).stage === 'mouth-landmarks') {
      const messages: AIMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: mouthLandmarksPrompt() },
            {
              type: 'image_url',
              image_url: { url: image.dataUrl, detail: 'high' },
            },
          ],
        },
      ];
      const options = {
        model: config.model,
        maxTokens: MOUTH_LANDMARKS_MAX_TOKENS,
        reasoning: VISION_REASONING,
        responseFormat: { type: 'json_object' as const },
        signal: request.signal,
      };
      const landmarks = await ai.chat(messages, options);
      try {
        requireCompleteReply(landmarks);
        return json({ landmarks: parseMouthLandmarks(landmarks.content) });
      } catch (cause) {
        if (request.signal.aborted) error(499, 'Photo setup cancelled.');
        const reason = rejectedReplyReason(landmarks, cause);
        // biome-ignore lint/suspicious/noConsole: server-only diagnostic excludes image, prompt, response, and configuration.
        console.info('[dev-character-setup] landmark repair:', reason);
        const repair = await ai.chat(
          [
            ...messages,
            { role: 'assistant', content: landmarks.content },
            {
              role: 'user',
              content: `The landmarks were rejected: ${reason}. Return repaired mouthLeft, mouthRight and chin JSON only.`,
            },
          ],
          options,
        );
        requireCompleteReply(repair);
        return json({ landmarks: parseMouthLandmarks(repair.content) });
      }
    }
    const message: AIMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: photoCutoutSetupPrompt({
              assetId: SOURCE_ID,
              width: image.width,
              height: image.height,
            }),
          },
          { type: 'image_url', image_url: { url: image.dataUrl } },
        ],
      },
    ];
    const options = {
      model: config.model,
      maxTokens: 1800,
      responseFormat: { type: 'json_object' as const },
      signal: request.signal,
    };
    const result = await ai.chat(message, options);
    try {
      return json({
        rig: parsePhotoCutoutSetup(result.content, {
          assetId: SOURCE_ID,
          width: image.width,
          height: image.height,
        }),
      });
    } catch (validation) {
      if (request.signal.aborted) error(499, 'Photo setup cancelled.');
      const reason =
        validation instanceof Error
          ? validation.message.replace(/[^a-zA-Z0-9 .:_-]/g, '').slice(0, 240)
          : 'invalid cutout geometry';
      // Deliberately never log source image bytes, prompts, provider output, or config.
      // biome-ignore lint/suspicious/noConsole: server-only validator diagnostic is intentionally withheld from the browser.
      console.info('[dev-character-setup] validator repair:', reason);
      const repair = await ai.chat(
        [
          ...message,
          { role: 'assistant', content: result.content },
          {
            role: 'user',
            content: `The prior JSON was rejected: ${reason}. Return a complete repaired JSON object only. The jaw polygon and pivot must be strictly inside the head polygon with a visible inset; mouth must be inside jaw; preserve canvas and source asset id.`,
          },
        ],
        options,
      );
      return json({
        rig: parsePhotoCutoutSetup(repair.content, {
          assetId: SOURCE_ID,
          width: image.width,
          height: image.height,
        }),
      });
    }
  } catch (cause) {
    if (request.signal.aborted) error(499, 'Photo setup cancelled.');
    error(
      422,
      'Photo setup did not return valid cutout geometry. Try again or choose a different photo.',
    );
  }
};

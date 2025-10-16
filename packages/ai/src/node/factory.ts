/**
 * Node.js-specific factory functions for creating AI provider instances
 * Includes support for environment variable detection
 */

import { ValidationError } from '@have/utils';
import { getAI as getAIUniversal } from '../shared/factory';

import type {
  AIInterface,
  BedrockOptions,
  HuggingFaceOptions,
  OpenAIOptions,
} from '../shared/types';

/**
 * Re-export the universal getAI function
 */
export { getAI } from '../shared/factory';

/**
 * Node.js-enhanced auto-detection of AI provider based on available credentials
 * Includes support for environment variables
 *
 * @param options - Configuration options that may contain provider-specific credentials
 * @returns Promise resolving to an AI provider instance
 * @throws ValidationError if no provider can be detected from the options
 */
export async function getAIAuto(
  options: Record<string, any> = {},
): Promise<AIInterface> {
  // First try universal detection
  try {
    return await import('../shared/factory.js').then((m) =>
      m.getAIAuto(options),
    );
  } catch (_error) {
    // If universal detection fails, try Node.js-specific environment variables
  }

  // Auto-detect provider based on available credentials including environment variables
  if ((options.apiKey || process.env.OPENAI_API_KEY) && !options.type) {
    // Default to OpenAI if apiKey is provided without explicit type
    return getAIUniversal({
      ...options,
      type: 'openai',
      apiKey: options.apiKey || process.env.OPENAI_API_KEY,
    } as OpenAIOptions);
  }

  if (options.apiToken || process.env.HF_TOKEN) {
    // Hugging Face uses apiToken or HF_TOKEN
    return getAIUniversal({
      ...options,
      type: 'huggingface',
      apiToken: options.apiToken || process.env.HF_TOKEN,
    } as HuggingFaceOptions);
  }

  if (
    (options.region || process.env.AWS_DEFAULT_REGION) &&
    (options.credentials || process.env.AWS_ACCESS_KEY_ID)
  ) {
    // AWS Bedrock uses region and AWS credentials (explicit or from env)
    const bedrockOptions: BedrockOptions = {
      ...options,
      type: 'bedrock',
      region: options.region || process.env.AWS_DEFAULT_REGION,
    };

    // Add credentials if available in environment
    if (
      !options.credentials &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY
    ) {
      bedrockOptions.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }

    return getAIUniversal(bedrockOptions);
  }

  throw new ValidationError(
    'Could not auto-detect AI provider from options or environment',
    {
      hint: 'Please specify a "type" field in options or provide provider-specific credentials/environment variables',
      supportedTypes: [
        'openai',
        'gemini',
        'anthropic',
        'huggingface',
        'bedrock',
      ],
      providedOptions: Object.keys(options),
      checkedEnvVars: [
        'OPENAI_API_KEY',
        'HF_TOKEN',
        'AWS_ACCESS_KEY_ID',
        'AWS_DEFAULT_REGION',
      ],
    },
  );
}

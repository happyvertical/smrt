import {
  definePrompt,
  type ResolvedPromptAI,
} from '@happyvertical/smrt-prompts';

export const smrtContentReviewPrompt = definePrompt({
  key: 'smrtContent.review',
  template: `Content review request

Content ID: {contentId}
Review kind: {kind}
Policy key: {policyKey}
Title: {contentTitle}
Description: {contentDescription}

Body:
{contentBody}

{reviewPrompt}`,
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

export const smrtContentApplyCorrectionPrompt = definePrompt({
  key: 'smrtContent.applyCorrection',
  template: `You are revising an article draft to apply a factual correction.

Return only the fully revised body text, with no commentary.

Current body:
{body}

Correction summary:
{summary}

Incorrect text to fix:
{incorrectText}

Corrected text to incorporate:
{correctedText}`,
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

export const smrtContentThumbnailAIGeneratePrompt = definePrompt({
  key: 'smrtContent.thumbnail.aiGenerate',
  template: `Create a {style} thumbnail image for an article titled "{title}". {descriptionClause}Style: {styleHint}. The image should be suitable for a news article or blog post thumbnail.`,
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

export function promptMessageOptions(ai: ResolvedPromptAI) {
  return {
    ...(ai.params || {}),
    ...(ai.model ? { model: ai.model } : {}),
    ...(typeof ai.temperature === 'number'
      ? { temperature: ai.temperature }
      : {}),
    ...(typeof ai.maxTokens === 'number' ? { maxTokens: ai.maxTokens } : {}),
  };
}

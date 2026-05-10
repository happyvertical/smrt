/**
 * Prompt registrations for the @happyvertical/smrt-ledgers package.
 *
 * Prompts are registered at module-load time via `definePrompt()` so that
 * tenant-aware overrides can be applied at call time via `resolvePrompt()`.
 *
 * Mirrors the pattern used by `@happyvertical/smrt-properties` (see
 * `prompts.ts`) and `@happyvertical/smrt-content` (see `content-prompts.ts`).
 */

import {
  definePrompt,
  type ResolvedPromptAI,
} from '@happyvertical/smrt-prompts';

// Journal summarization only uses non-PII journal fields
// (number, date, description, status, balanced flag) plus aggregate totals
// and entry count. Internal/foreign-key fields like tenantId, sourceRef,
// individual entry account IDs, and the extensible `metadata` blob are
// intentionally NOT passed to the AI provider — they may link to identifying
// records (customer/vendor IDs via sourceRef) or contain tenant-private
// configuration. If a downstream tenant needs richer context they can
// override the template via PromptOverride.
export const smrtLedgersJournalSummarizePrompt = definePrompt({
  key: 'smrtLedgers.journal.summarize',
  template: `Summarize this accounting journal entry:
Number: {journalNumber}
Date: {journalDate}
Description: {journalDescription}
Status: {journalStatus}
Total: \${journalTotal}
Entries: {entryCount}
Balanced: {journalBalanced}`,
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

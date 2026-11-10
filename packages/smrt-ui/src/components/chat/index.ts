/**
 * Chat primitives — subpath `@happyvertical/smrt-ui/chat`.
 *
 * MessageBubble (user/agent/system), ReactionPicker, TypingIndicator, and
 * `requestAssistant` (ask the page's assistant from any element). Generic,
 * tokenised, a11y-checked building blocks for chat UIs (L3 #1422).
 */

export {
  ASSISTANT_REQUEST_EVENT,
  type AssistantRequestDetail,
  requestAssistant,
} from './assistant-request.js';
export { default as MessageBubble } from './MessageBubble.svelte';
export { default as ReactionPicker } from './ReactionPicker.svelte';
export { default as TypingIndicator } from './TypingIndicator.svelte';

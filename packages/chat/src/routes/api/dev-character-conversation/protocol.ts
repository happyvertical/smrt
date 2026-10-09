export const DEV_CHARACTER_MAX_DRAFT_LENGTH = 200;
export const DEV_CHARACTER_MAX_REQUEST_BYTES = 16 * 1024;
export const DEV_CHARACTER_MAX_MESSAGES = 24;

/**
 * Browser-safe protocol for the local character conversation workbench.
 *
 * The proposal is deliberately descriptive: a host renders its canonical
 * preview and performs any browser-side effect only after a trusted user
 * confirmation. This module contains no capability to apply a proposal.
 */
export const DEV_CHARACTER_CONVERSATION_SECTIONS = [
  'character',
  'conversation',
  'chat',
] as const;

export type DevCharacterConversationSection =
  (typeof DEV_CHARACTER_CONVERSATION_SECTIONS)[number];

export type DevCharacterConversationProposal =
  | {
      kind: 'navigate';
      section: DevCharacterConversationSection;
      preview: {
        title: string;
        description: string;
      };
    }
  | {
      kind: 'stageDraft';
      value: string;
      preview: {
        title: string;
        description: string;
      };
    };

export interface DevCharacterConversationResponse {
  content: string;
  model?: string;
  proposal?: DevCharacterConversationProposal;
}

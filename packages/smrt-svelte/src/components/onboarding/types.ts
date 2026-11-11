import type { AssistantApprovalView } from '@happyvertical/smrt-chat/assistant-turn';

export interface OnboardingProgress {
  step: 'welcome' | 'ai' | 'template' | 'done';
  completed: boolean;
  rerunning: boolean;
  selected: string | null;
  approvalId: string | null;
}
export interface OnboardingTemplate {
  id: string;
  name: string;
  description: string;
  lists: string[];
  missing: string[];
}
export interface OnboardingState extends OnboardingProgress {
  revision: string;
  templates: OnboardingTemplate[];
  preview: null | {
    id: string;
    previewToken: string;
    revision: number;
    before: string[];
    after: string[];
  };
  approval: AssistantApprovalView | null;
}
export type OnboardingAction =
  | {
      action:
        | 'welcome'
        | 'continue'
        | 'skip'
        | 'back'
        | 'apply'
        | 'restart'
        | 'cancel';
    }
  | { action: 'preview'; id: string };
export interface OnboardingClient {
  state(signal?: AbortSignal): Promise<OnboardingState>;
  change(
    change: OnboardingAction,
    revision: string,
    signal?: AbortSignal,
  ): Promise<OnboardingState>;
}

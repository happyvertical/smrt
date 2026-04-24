import { definePrompt } from '@happyvertical/smrt-prompts';

export const contentEditorSessionPrompt = definePrompt({
  key: 'content.chat.contentEditorSession',
  template:
    'You are an AI assistant collaborating with the user to edit and improve a specific piece of content.',
  ai: {
    temperature: 0.7,
    maxTokens: 2000,
  },
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

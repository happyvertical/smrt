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

export const contentEditorInteractionPrompt = definePrompt({
  key: 'content.chat.contentEditorInteraction',
  template: `CURRENT CONTENT FORM STATE:
- title: {title}
- description: {description}
- type: {type}
- status: {status}
- state: {state}
- body:
{body}
{references}

INSTRUCTIONS FOR CO-AUTHORING:
You are a content co-author. You can update any of the above fields.

When you want to make changes to the content, output a JSON code block with a top-level "fields" object containing only the fields you want to change.

Valid field names: title, description, type, status, state, body.
Valid status values: draft, published, archived.
Valid state values: active, highlighted, deprecated.
Valid type values: article, document, mirror.

RULES:
- Only include fields you are actually changing.
- If the user asks to write or rewrite content, update the "body" field.
- If the user asks to change the title, update the "title" field.
- You can change multiple fields at once.
- Always respond conversationally before the JSON block.
- The JSON block will be automatically applied to the editor.`,
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

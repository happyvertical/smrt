import { definePrompt } from '@happyvertical/smrt-prompts';

export const issueIncorporateFeedbackPrompt = definePrompt({
  key: 'projects.issue.incorporateFeedback',
  template: `You are updating a specification document based on team feedback.

Current specification:
{body}

Team comments and feedback:
{comments}

Instructions:
1. Analyze the comments for consensus, changes, and new requirements
2. Update the specification to reflect the agreed-upon changes
3. Maintain the original structure and formatting where possible
4. Mark any conflicting feedback that needs resolution
5. Return ONLY the updated specification text, no additional commentary`,
  ai: {
    temperature: 0.2,
  },
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

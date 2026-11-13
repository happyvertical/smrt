// Tricia keeps its saved chip wording through chat's shared label mechanism.
import { toolSummary as sharedToolSummary } from '@happyvertical/smrt-chat/tool-summary';

export const toolSummary = (name: string, result: unknown, ok = true): string =>
  sharedToolSummary(name, result, ok, {
    recordLabels: 'generic',
    plainTextSummary: true,
  });

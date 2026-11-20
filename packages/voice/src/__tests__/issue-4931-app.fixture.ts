/** Runtime app replacements, dynamically imported after their package models. */
import { smrt } from '@happyvertical/smrt-core';
import { VoiceOutput as SmrtVoiceOutput } from '../voice-output.js';

const VoiceOutput: typeof SmrtVoiceOutput = class VoiceOutput extends SmrtVoiceOutput {};
smrt({ replaceParent: true, packageName: '@local/issue4931-voice' })(
  VoiceOutput,
);

// One object, not a named export per class: an export under a model's name
// must be that model, and these replacements are other classes of that name.
export const appModels = { VoiceOutput };

/** Runtime app replacements, dynamically imported after their package models. */
import { smrt } from '@happyvertical/smrt-core';
import { VoiceOutput as SmrtVoiceOutput } from '../voice-output.js';

export const VoiceOutput: typeof SmrtVoiceOutput = class VoiceOutput extends SmrtVoiceOutput {};
smrt({ packageName: '@local/issue4931-voice' })(VoiceOutput);

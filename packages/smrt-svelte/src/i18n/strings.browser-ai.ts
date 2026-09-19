import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  'ui.model_status.webgpu_unavailable':
    'This browser does not expose WebGPU, so the model cannot run here. Inference will use the server route instead.',
});

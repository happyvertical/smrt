import { renderOpenAiForm } from '../src/forms-view.js';
const host = document.createElement('main');
document.body.append(host);
const mode = new URLSearchParams(location.search).get('mode');
const view = renderOpenAiForm(host, {
  schema: {
    type: 'object',
    required: ['name', 'resource'],
    properties: {
      name: { type: 'string', title: 'Name', maxLength: 16 },
      enabled: { type: 'boolean', title: 'Enabled' },
      resource: {
        type: 'string',
        title: 'Resource',
        format: 'uri',
        'x-openai-input': {
          type: 'resource',
          options: [
            {
              uri: 'resource://opaque/one',
              name: '<img src=x onerror=alert(1)>',
            },
            { uri: 'resource://opaque/two', name: 'Second synthetic resource' },
          ],
        },
      },
    },
  },
  submit: async (reply) => {
    if (mode === 'failure') throw new Error('Synthetic upstream failure');
    const result = await fetch('/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reply),
    });
    if (!result.ok) throw new Error('Submit failed');
  },
});
(window as any).dispose = () => view.dispose();

import { renderOpenAiForm } from '../src/forms-view.js';
const host = document.createElement('main');
document.body.append(host);
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const view = renderOpenAiForm(host, {
  schema: mode === 'roundtrip' ? { type: 'object', properties: { values: { type: 'array', title: 'Values', items: { type: 'string' }, default: params.get('value') === 'newline' ? ['a\nb'] : params.get('value') === 'empty' ? [''] : ['a'.repeat(3000), 'b'.repeat(3000)] } } } : mode === 'empty-choice' ? { type: 'object', properties: { choice: { type: 'string', title: 'Choice', ...(params.has('oneOf') ? { oneOf: [{const: '', title: 'Empty choice'}, {const: 'x', title: 'X'}] } : { enum: ['', 'x'], enumNames: ['Empty choice', 'X'] }), ...(params.has('default') ? {default: ''} : {}) }, text: {type: 'string', title: 'Text'} } } : mode === 'array' ? {
    type: 'object',
    required: params.has('required') ? ['values'] : [],
    properties: {
      values: { type: 'array', title: 'Values', minItems: params.has('empty') ? 0 : 1,
        items: params.get('control') === 'select' ? { type: 'string', enum: ['one', 'two'] } : { type: 'string' },
      },
    },
  } : {
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

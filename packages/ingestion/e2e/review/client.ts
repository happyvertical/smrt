import type { IntakeReviewHost } from '../../src/review-dto.js';

let csrf = '';
export async function login(username = 'owner') {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'review-fixture' }),
  });
  csrf = (await response.json()).csrf;
}
async function call(path: string, input?: unknown) {
  const response = await fetch(
    `/api/${path}`,
    input === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-review-csrf': csrf,
          },
          body: JSON.stringify(input),
        },
  );
  if (!response.ok) throw new Error('Review unavailable');
  return response.json();
}
export async function session() {
  csrf = (await call('session')).csrf;
}
export const host: IntakeReviewHost = {
  list: (input) =>
    call(
      `list?${new URLSearchParams(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined))}`,
    ),
  load: (itemId, cursor) =>
    call(
      `load?${new URLSearchParams({ itemId, ...(cursor ? { cursor } : {}) })}`,
    ),
  upload: async (files, requestId) => {
    if (files.length !== 1)
      throw new Error('Choose one original per fixture upload');
    const file = files[0],
      form = new FormData();
    form.set('captureId', requestId);
    form.set('capturedAt', new Date().toISOString());
    form.set('captureSource', 'document');
    form.set('file', file);
    const hash = await crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer(),
    );
    form.set(
      'sha256',
      Array.from(new Uint8Array(hash), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join(''),
    );
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-review-csrf': csrf, 'idempotency-key': requestId },
      body: form,
    });
    if (!response.ok) throw new Error('Upload unavailable');
    return response.json();
  },
  preview: (input) => call('preview', input),
  decide: (input) => call('decide', input),
  apply: (actionId) => call('apply', { actionId }),
  candidates: (input) => call('candidates', input),
  assign: (input) => call('assign', input),
  split: (input) => call('split', input),
  editPlan: (input) => call('editPlan', input),
  editAction: (input) => call('editAction', input),
};

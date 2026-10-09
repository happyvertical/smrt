import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { embeddedPDF } from '../../src/test-support/extraction-fixtures.js';
import { twoPagePDF } from './fixtures.js';

async function signIn(page: Page) {
  await page.goto('/e2e/review/index.html');
  await page.getByRole('button', { name: 'Sign in to review fixture' }).click();
  await expect(page.getByTestId('intake-inbox')).toBeVisible();
}
async function upload(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
) {
  await page
    .locator('input[type=file]')
    .setInputFiles({ name, mimeType, buffer });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByTestId('intake-review')).toBeVisible();
  await expect(page.getByTestId('intake-review')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  return new URL(page.url()).searchParams.get('itemId')!;
}
async function csrf(page: Page) {
  return (await (await page.request.get('/api/session')).json()).csrf as string;
}

test('real PDF upload, exact correction, stale tab refusal, reload and one actual domain result', async ({
  page,
  context,
}) => {
  await signIn(page);
  const itemId = await upload(
    page,
    'minutes.pdf',
    'application/pdf',
    embeddedPDF('Meeting minutes: retain this original.'),
  );
  await expect(
    page.getByTestId('evidence-viewer').locator('iframe'),
  ).toBeVisible();
  await expect(page.getByTestId('intake-review')).toContainText(
    'Meeting minutes',
  );
  await expect(
    page.getByText('Confidence unavailable', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Prepare review', exact: true })
    .click();
  const args = page.getByRole('textbox', {
    name: 'Exact arguments (JSON)',
    exact: true,
  });
  await expect(args).toBeVisible();
  const snapshot = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  const review = snapshot.reviews.actions[0].review;
  await expect(
    page.getByRole('button', { name: 'Correct', exact: true }),
  ).toHaveCount(0);
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(
    other.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeVisible();
  await args.fill(
    JSON.stringify({
      title: 'Human reviewed title',
      body: 'Human reviewed minutes',
    }),
  );
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Save edits for new review', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Exact arguments (JSON)', exact: true }),
  ).toHaveValue(/Human reviewed title/);
  await other.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(other.getByRole('alert')).toBeVisible();
  await expect(other.getByTestId('evidence-viewer')).toHaveCount(0);
  const forged = await page.request.post('/api/decide', {
    headers: { 'x-review-csrf': await csrf(page) },
    data: {
      actionId: review.actionId,
      expectedRevision: review.revision,
      expectedReviewVersion: review.reviewVersion,
      bindingHash: review.bindingHash,
      requestId: randomUUID(),
      decision: 'approve',
      reviewer: 'owner',
    },
  });
  expect(forged.status()).toBe(409);
  expect(
    (
      await page.request.post('/api/preview', {
        headers: { 'x-review-csrf': await csrf(page) },
        data: {
          itemId,
          attemptId: snapshot.analysis.attemptId,
          index: 999,
          requestId: randomUUID(),
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (await (await page.request.get(`/api/load?itemId=${itemId}`)).json())
      .reviews.actions,
  ).toHaveLength(1);
  expect(
    (
      await page.request.post('/api/feedback', {
        headers: { 'x-review-csrf': await csrf(page) },
        data: {
          itemId,
          actionId: review.actionId,
          judgment: 'correct',
          requestId: randomUUID(),
        },
      })
    ).status(),
  ).toBe(409);
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Exact arguments (JSON)', exact: true }),
  ).toHaveValue(/Human reviewed title/);
  const reloaded = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(reloaded.reviews.actions[0].review.actionId).toBe(review.actionId);
  await page.getByRole('button', { name: 'Approve', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Apply approved action', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Exact arguments (JSON)', exact: true })
    .fill(
      JSON.stringify({
        title: 'Final approved title',
        body: 'Human reviewed minutes',
      }),
    );
  await expect(
    page.getByRole('button', { name: 'Apply approved action', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Save edits for new review', exact: true })
    .click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page
    .getByRole('button', { name: 'Apply approved action', exact: true })
    .click();
  await expect(page.getByTestId(`action-${review.actionId}`)).toContainText(
    'succeeded',
  );
  const final = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  const result = final.reviews.actions[0].result;
  const domain = await (
    await page.request.get(`/api/result?id=${result.result.contentId}`)
  ).json();
  expect(domain).toMatchObject({
    id: result.result.contentId,
    title: 'Final approved title',
    body: 'Human reviewed minutes',
    status: 'draft',
  });
  const repeated = await page.request.post('/api/apply', {
    headers: { 'x-review-csrf': await csrf(page) },
    data: { actionId: review.actionId },
  });
  expect(await repeated.json()).toEqual(result);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await other.close();
});

test('authenticated originals, CSRF, assignment CAS and foreign tenant boundaries', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const itemId = await upload(
    page,
    'message.txt',
    'text/plain',
    Buffer.from(
      '<img src=x onerror="window.pwned=true"> Private email context',
    ),
  );
  await expect(page.getByTestId('evidence-viewer')).toContainText(
    'Private email context',
  );
  expect(
    await page.evaluate(() => Reflect.get(window, 'pwned')),
  ).toBeUndefined();
  const assignment = {
    itemId,
    expectedVersion: 0,
    assigneeId: 'reviewer',
    requestId: randomUUID(),
  };
  expect(
    (await page.request.post('/api/assign', { data: assignment })).status(),
  ).toBe(403);
  expect(
    (await page.request.get('/api/assign', { data: assignment })).status(),
  ).toBe(405);
  const headers = { 'x-review-csrf': await csrf(page) };
  expect(
    (
      await page.request.post('/api/assign', { headers, data: assignment })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post('/api/assign', { headers, data: assignment })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post('/api/assign', {
        headers,
        data: { ...assignment, requestId: randomUUID(), assigneeId: 'owner' },
      })
    ).status(),
  ).toBe(409);
  await page.reload();
  const current = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(current.entry.assignment).toEqual({
    assigneeId: 'reviewer',
    version: 1,
  });
  const foreign = await browser.newContext();
  const response = await foreign.request.post(
    'http://127.0.0.1:5595/api/session',
    { data: { username: 'foreign', password: 'review-fixture' } },
  );
  expect(response.ok()).toBe(true);
  expect(
    (
      await foreign.request.get(
        `http://127.0.0.1:5595/api/load?itemId=${itemId}`,
      )
    ).status(),
  ).toBe(409);
  expect(
    (
      await foreign.request.get(
        `http://127.0.0.1:5595${current.evidence[0].viewUrl}`,
      )
    ).status(),
  ).toBe(409);
  expect(
    (
      await foreign.request.post('http://127.0.0.1:5595/api/candidates', {
        headers: { 'x-review-csrf': (await response.json()).csrf },
        data: {
          itemId,
          handlerId: '@happyvertical/smrt-ingestion-reference:attach-evidence',
          handlerVersion: '1',
          query: '',
        },
      })
    ).status(),
  ).toBe(409);
  await foreign.close();
});

test('mobile image/audio originals retain honest provider failure and absent timestamps', async ({
  page,
}) => {
  await signIn(page);
  const corpus = new URL(
    '../../src/test-support/extraction-corpus/',
    import.meta.url,
  );
  await upload(
    page,
    'scene.jpg',
    'image/jpeg',
    await readFile(new URL('scene.jpg', corpus)),
  );
  await expect(
    page.getByTestId('evidence-viewer').locator('img'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toHaveCount(0);
  await upload(
    page,
    'audio.wav',
    'audio/wav',
    await readFile(new URL('recorded-tone.wav', corpus)),
  );
  await expect(
    page.getByTestId('evidence-viewer').locator('audio'),
  ).toBeVisible();
  await expect(page.locator('a[href*="#t="]')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toHaveCount(0);
});

test('revoked refresh removes previously rendered private evidence and proposals', async ({
  page,
}) => {
  // Use reviewer so revocation does not affect the other owner scenarios.
  await page.goto('/e2e/review/index.html');
  await page.request.post('/api/session', {
    data: { username: 'reviewer', password: 'review-fixture' },
  });
  await page.reload();
  const itemId = await upload(
    page,
    'private.txt',
    'text/plain',
    Buffer.from('Revoked private evidence'),
  );
  await expect(page.getByTestId('evidence-viewer')).toContainText(
    'Revoked private evidence',
  );
  await page.request.post('/api/revoke', {
    headers: { 'x-review-csrf': await csrf(page) },
    data: {},
  });
  await page
    .getByRole('button', { name: 'Refresh', exact: true })
    .last()
    .click();
  await expect(
    page.getByTestId('intake-review').getByRole('alert'),
  ).toBeVisible();
  await expect(page.getByTestId('evidence-viewer')).toHaveCount(0);
  expect((await page.request.get(`/api/load?itemId=${itemId}`)).status()).toBe(
    409,
  );
});

test('human page regrouping preserves the original and forces new review after real re-extraction', async ({
  page,
}) => {
  await signIn(page);
  const original = twoPagePDF();
  const itemId = await upload(
    page,
    'two-documents.pdf',
    'application/pdf',
    original,
  );
  await page
    .getByRole('button', { name: 'Prepare review', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Apply approved action', exact: true }),
  ).toBeVisible();
  const before = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  await page
    .getByRole('textbox', { name: /Logical page groups/ })
    .fill('[[1,2]]');
  await page
    .getByRole('button', { name: 'Save split and reprocess', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Prepare review', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Apply approved action', exact: true }),
  ).toHaveCount(0);
  const after = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(after.analysis.revision).toBe(before.analysis.revision + 2);
  expect(after.analysis.configuration.humanCorrection).toMatchObject({
    actorId: 'owner',
    kind: 'logical_split',
    groups: [[1, 2]],
  });
  const pdf = after.evidence.find(
    (entry: { evidence: { mediaType: string } }) =>
      entry.evidence.mediaType === 'application/pdf',
  );
  expect(await (await page.request.get(pdf.viewUrl)).body()).toEqual(original);
  await page
    .getByRole('button', { name: 'Prepare review', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeVisible();
  const final = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(final.reviews.actions[0].review.actionId).toBe(
    before.reviews.actions[0].review.actionId,
  );
  expect(final.reviews.actions[0].review.revision).toBe(
    before.reviews.actions[0].review.revision + 1,
  );
});

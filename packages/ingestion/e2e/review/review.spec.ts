import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/upload') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  expect((await uploaded).ok()).toBe(true);
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
  ).toHaveCount(1);
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
  const feedbackReview = (
    await (await page.request.get(`/api/load?itemId=${itemId}`)).json()
  ).reviews.actions[0].review;
  const feedbackResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/feedback') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  const recorded = await feedbackResponse;
  expect(recorded.status()).toBe(200);
  expect(recorded.request().postDataJSON()).toMatchObject({
    itemId,
    actionId: feedbackReview.actionId,
    expectedRevision: feedbackReview.revision,
    expectedReviewVersion: feedbackReview.reviewVersion,
    bindingHash: feedbackReview.bindingHash,
    judgment: 'incorrect',
  });
  expect(await recorded.json()).toMatchObject({ kind: 'interpretation' });
  expect(
    (
      await page.request.post('/api/feedback', {
        headers: { 'x-review-csrf': await csrf(page) },
        data: {
          ...recorded.request().postDataJSON(),
          expectedRevision: feedbackReview.revision + 1,
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

test('a reviewer completes a needs_review suggestion through the ordinary preview and approval path (#4208)', async ({
  page,
}) => {
  await signIn(page);
  const itemId = await upload(
    page,
    'statement.pdf',
    'application/pdf',
    embeddedPDF('Vendor statement [[missing-title]] retain this original.'),
  );
  const review = page.getByTestId('intake-review');
  await expect(review).toContainText('Missing information');
  await expect(review).toContainText(
    'This suggestion needs review. Complete or confirm its arguments',
  );
  const prepare = page.getByRole('button', {
    name: 'Prepare review',
    exact: true,
  });
  await expect(prepare).toBeDisabled();
  const snapshot = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(snapshot.generation.suggestions[0]).toMatchObject({
    disposition: 'needs_review',
    missingFields: ['title'],
  });
  // The generated arguments alone still fail the handler schema server-side.
  // The fixture's review transport reports that one case as a correctable
  // rejection body; nothing is published.
  const incomplete = await page.request.post('/api/preview', {
    headers: { 'x-review-csrf': await csrf(page) },
    data: {
      itemId,
      attemptId: snapshot.analysis.attemptId,
      index: 0,
      requestId: randomUUID(),
    },
  });
  expect(incomplete.status()).toBe(200);
  expect(await incomplete.json()).toEqual({ rejected: 'invalid' });
  // Only the action identity exists (created before preview, as on main);
  // no proposal, binding or arguments were published.
  const afterRefusal = (
    await (await page.request.get(`/api/load?itemId=${itemId}`)).json()
  ).reviews.actions as Array<{
    args?: unknown;
    review: { proposalId: string; bindingHash: string };
  }>;
  for (const action of afterRefusal) {
    expect(action.review.proposalId).toBe('');
    expect(action.review.bindingHash).toBe('');
    expect(action.args).toBeUndefined();
  }
  // Any other preview failure is still a refusal (here: a forged index).
  const forged = await page.request.post('/api/preview', {
    headers: { 'x-review-csrf': await csrf(page) },
    data: {
      itemId,
      attemptId: snapshot.analysis.attemptId,
      index: 7,
      requestId: randomUUID(),
    },
  });
  expect(forged.status()).toBe(409);
  const draft = page.getByRole('textbox', {
    name: 'Suggested arguments (JSON)',
    exact: true,
  });
  await draft.fill(
    JSON.stringify({
      ...snapshot.generation.suggestions[0].args,
      title: 'Human completed title',
    }),
  );
  await expect(prepare).toBeEnabled();
  await prepare.click();
  const args = page.getByRole('textbox', {
    name: 'Exact arguments (JSON)',
    exact: true,
  });
  await expect(args).toHaveValue(/Human completed title/);
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeEnabled();
  const prepared = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  const action = prepared.reviews.actions[0];
  expect(action.review.state).toBe('waiting_review');
  expect(action.args).toMatchObject({ title: 'Human completed title' });
  // The immutable generation still records what the model left unfilled.
  expect(prepared.generation.suggestions[0].missingFields).toEqual(['title']);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page
    .getByRole('button', { name: 'Apply approved action', exact: true })
    .click();
  await expect(
    page.getByTestId(`action-${action.review.actionId}`),
  ).toContainText('succeeded');
  const final = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  const domain = await (
    await page.request.get(
      `/api/result?id=${final.reviews.actions[0].result.result.contentId}`,
    )
  ).json();
  expect(domain).toMatchObject({
    title: 'Human completed title',
    status: 'draft',
  });
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
  const reprocessed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/split') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Save split and reprocess', exact: true })
    .click();
  expect((await reprocessed).status()).toBe(200);
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

test('a reviewer instruction is recorded immutably, reinterpreted in the background and lands in place as trusted guidance', async ({
  page,
}) => {
  // Two real re-extractions plus background interpretation under Chromium.
  test.setTimeout(150000);
  await signIn(page);
  const original = embeddedPDF('Purchase order 4471 from Badger Supply.');
  const itemId = await upload(
    page,
    'badger-po.pdf',
    'application/pdf',
    original,
  );
  // An action exists before the instruction: the item is "waiting", not
  // "processing", when the reviewer asks for a re-read.
  await page
    .getByRole('button', { name: 'Prepare review', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeVisible();
  const before = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(before.entry.state).toBe('waiting');
  expect(before.reviews.actions).toHaveLength(1);
  expect(before.instruction).toBeUndefined();
  expect(before.generation.provenance.reviewerInstruction).toBeUndefined();
  const text =
    'This is a customer PO from Badger. Do not bill it; just file it.';
  const box = page.getByRole('textbox', {
    name: 'Instructions for the assistant',
    exact: true,
  });
  const button = page.getByRole('button', {
    name: 'Re-read with these instructions',
    exact: true,
  });
  await expect(button).toBeDisabled();
  await box.fill(text);
  const recorded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/instruct') &&
      response.request().method() === 'POST',
  );
  await button.click();
  expect((await recorded).status()).toBe(200);
  // The reviewer is not blocked: the item reports the background stage and the
  // page refreshes itself when the fenced interpretation completes.
  await expect(page.getByTestId('reinterpreting')).toBeVisible();
  // The reviewer keeps working while it runs: a draft typed during the stage
  // survives the in-place refresh.
  await box.fill('draft while reinterpreting');
  await expect(page.getByTestId('applied-instruction')).toBeVisible({
    timeout: 30000,
  });
  await expect(box).toHaveValue('draft while reinterpreting');
  await box.fill('');
  await expect(page.getByTestId('applied-instruction')).toContainText(text);
  await expect(page.getByTestId('instruction-stale')).toHaveCount(0);
  await expect(page.getByTestId('reinterpreting')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Prepare review', exact: true }),
  ).toBeVisible();
  const after = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(after.analysis.revision).toBe(before.analysis.revision + 2);
  expect(after.reviews.actions[0].review.actionId).toBe(
    before.reviews.actions[0].review.actionId,
  );
  expect(after.reviews.actions[0].review.state).toBe('stale');
  expect(after.instruction.current.id).toBe(after.instruction.applied.id);
  expect(after.instruction.stale).toBe(false);
  expect(after.instruction.applied).toMatchObject({
    actorId: 'owner',
    text,
    supersedesId: null,
  });
  expect(after.analysis.configuration.reviewerInstruction).toMatchObject({
    kind: 'reviewer_instruction',
    id: after.instruction.applied.id,
    digest: after.instruction.applied.digest,
  });
  expect(after.generation.provenance.reviewerInstruction).toEqual({
    id: after.instruction.applied.id,
    digest: after.instruction.applied.digest,
  });
  expect(after.generation.provenance.catalogDigest).toBe(
    before.generation.provenance.catalogDigest,
  );
  expect(after.generation.automaticActionEligible).toBe(false);
  const pdf = after.evidence.find(
    (entry: { evidence: { mediaType: string } }) =>
      entry.evidence.mediaType === 'application/pdf',
  );
  expect(await (await page.request.get(pdf.viewUrl)).body()).toEqual(original);
  // Whitespace-only instruction text fails server-side validation, reported
  // as a validation result rather than an error status.
  const blankText = await page.request.post('/api/instruct', {
    headers: { 'x-review-csrf': await csrf(page) },
    data: {
      itemId,
      attemptId: after.analysis.attemptId,
      expectedRevision: after.analysis.revision,
      text: ' ',
      requestId: randomUUID(),
    },
  });
  expect(blankText.status()).toBe(200);
  expect(await blankText.json()).toEqual({ invalid: true });
  // A superseding instruction replaces the first for future interpretations;
  // the earlier record remains in history.
  await box.fill('Second thoughts: file it under supplier correspondence.');
  const superseded = page.waitForResponse((response) =>
    response.url().endsWith('/api/instruct'),
  );
  await button.click();
  expect((await superseded).status()).toBe(200);
  await expect(page.getByTestId('applied-instruction')).toContainText(
    'supplier correspondence',
    { timeout: 30000 },
  );
  const final = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(final.instruction.applied.supersedesId).toBe(
    after.instruction.applied.id,
  );
  expect(final.analysis.revision).toBe(after.analysis.revision + 2);
});

test('same local file reselection starts a new upload while chooser cancellation retains retry', async ({
  page,
}) => {
  await signIn(page);
  const bytes = embeddedPDF('Explicit same-file selection evidence.');
  const path = test.info().outputPath('same-original.pdf');
  await writeFile(path, bytes);
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  const requests: { key: string; sourceHash: boolean }[] = [];
  const receipts: string[] = [];
  page.on('response', async (response) => {
    if (
      response.url().endsWith('/api/upload') &&
      response.request().method() === 'POST' &&
      response.ok()
    )
      receipts.push((await response.json()).itemId);
  });
  await page.route('**/api/upload', async (route) => {
    const request = route.request();
    requests.push({
      key: request.headers()['idempotency-key'],
      sourceHash: request.postData()!.includes(expectedHash),
    });
    if (requests.length <= 2) {
      await route.fulfill({
        status: 503,
        body: 'Synthetic transport unavailable',
      });
      return;
    }
    await route.continue();
  });
  const input = page.locator('input[type=file]');
  const picker = page.getByText('Choose intake files', { exact: true });
  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  async function choose() {
    const chooser = page.waitForEvent('filechooser');
    await picker.click();
    await (await chooser).setFiles(path);
  }
  await choose();
  await upload.click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(requests).toHaveLength(1);
  const originalKey = requests[0].key;
  expect(originalKey).toMatch(/^[0-9a-f-]{36}$/);

  // Opening without selecting a new file must not discard the retained retry.
  const cancelled = page.waitForEvent('filechooser');
  await picker.click();
  await cancelled;
  await page.keyboard.press('Escape');
  await expect(
    page.getByText('1 file selected', { exact: true }),
  ).toBeVisible();
  await expect(upload).toBeEnabled();
  await upload.click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(requests[1].key).toBe(originalKey);
  expect(requests.every((request) => request.sourceHash)).toBe(true);

  // Exact same path, name and bytes, selected through Chromium's native picker.
  await choose();
  await upload.click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].key).not.toBe(originalKey);
  await expect(page.getByTestId('intake-review')).toBeVisible();
  await expect(page.getByTestId('intake-inbox')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(upload).toBeDisabled();

  // The successful selection's native FileList must not suppress another arrival.
  expect(
    await input.evaluate((element: HTMLInputElement) => element.files?.length),
  ).toBe(1);
  await choose();
  await expect(upload).toBeEnabled();
  await upload.click();
  await expect.poll(() => receipts.length).toBe(2);
  await expect(page.getByTestId('intake-inbox')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(requests[3].key).not.toBe(requests[2].key);
  expect(new Set(receipts).size).toBe(2);
  expect(requests.every((request) => request.sourceHash)).toBe(true);
});

test('switching intake context discards chooser retry state and fences a late real upload', async ({
  page,
}) => {
  await signIn(page);
  const path = test.info().outputPath('old-context.pdf');
  await writeFile(
    path,
    embeddedPDF('Old context must not select this receipt.'),
  );
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/upload', async (route) => {
    started();
    await pending;
    await route.continue();
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Choose intake files', { exact: true }).click();
  await (await chooser).setFiles(path);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await requested;
  await expect(page.getByTestId('intake-inbox')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await page
    .getByRole('button', { name: 'Switch intake context', exact: true })
    .click();
  await expect(page.getByTestId('intake-inbox')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    page.getByRole('button', { name: 'Upload', exact: true }),
  ).toBeDisabled();
  expect(
    await page
      .locator('input[type=file]')
      .evaluate((element: HTMLInputElement) => element.files?.length),
  ).toBe(0);
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/upload') &&
      response.request().method() === 'POST',
  );
  release();
  const response = await uploaded;
  expect(response.ok()).toBe(true);
  const original = await response.json();
  expect(original.itemId).toBeTruthy();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('intake-inbox')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.getByTestId('intake-review')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('itemId')).toBeNull();
  await expect(
    page.getByRole('button', { name: 'Upload', exact: true }),
  ).toBeDisabled();
});

// Routing-feedback capture for both paths is asserted at the service level in
// src/test-support/proposals.ts; this scenario proves the browser journeys.
test('reviewer starts a chosen handler through preview and approval, and closes another item without action', async ({
  page,
}) => {
  await signIn(page);
  const review = page.getByTestId('intake-review');
  const itemId = await upload(
    page,
    'customer-po.txt',
    'text/plain',
    Buffer.from('Customer purchase order 17 from Acme for widgets'),
  );
  const picker = review.getByRole('combobox', { name: 'Handler' });
  await expect(picker).toBeVisible();
  await picker.selectOption(
    '@happyvertical/smrt-ingestion-reference:create-draft@1',
  );
  const args = review.getByRole('textbox', {
    name: 'Initial arguments (JSON)',
  });
  // Pre-filled from the same-handler suggestion, then changed by the reviewer.
  await expect(args).toHaveValue(/Reviewed intake draft/);
  await args.fill(
    JSON.stringify({ title: 'Customer PO 17', body: 'Acme purchase order' }),
  );
  await review
    .getByRole('textbox', { name: 'Reason', exact: true })
    .fill('Customer PO, not a vendor bill');
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/startAction') &&
      response.request().method() === 'POST',
  );
  await review.getByRole('button', { name: 'Start action' }).click();
  const startResponse = await started;
  expect(startResponse.status()).toBe(200);
  expect(startResponse.request().postDataJSON()).toMatchObject({
    itemId,
    handlerId: '@happyvertical/smrt-ingestion-reference:create-draft',
    handlerVersion: '1',
    args: { title: 'Customer PO 17', body: 'Acme purchase order' },
    reason: 'Customer PO, not a vendor bill',
  });
  await expect(review.getByText('Started by a reviewer')).toBeVisible();
  const loaded = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  expect(loaded.reviews.actions).toHaveLength(1);
  expect(loaded.reviews.actions[0]).toMatchObject({
    origin: 'reviewer-selected',
    args: { title: 'Customer PO 17', body: 'Acme purchase order' },
  });
  expect(loaded.entry.state).toBe('waiting');
  await review.getByRole('button', { name: 'Approve', exact: true }).click();
  await review
    .getByRole('button', { name: 'Apply approved action', exact: true })
    .click();
  await expect(
    page.getByTestId(`action-${loaded.reviews.actions[0].review.actionId}`),
  ).toContainText('succeeded');
  const applied = await (
    await page.request.get(`/api/load?itemId=${itemId}`)
  ).json();
  const domain = await (
    await page.request.get(
      `/api/result?id=${applied.reviews.actions[0].result.result.contentId}`,
    )
  ).json();
  expect(domain).toMatchObject({ title: 'Customer PO 17', status: 'draft' });
  // A second item is closed as handled without any action.
  const paidId = await upload(
    page,
    'paid-invoice.txt',
    'text/plain',
    Buffer.from('Paid invoice 9 from Initech, nothing to do'),
  );
  await review
    .getByRole('textbox', { name: 'Reason for no action' })
    .fill('Already paid');
  const resolved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/resolve') &&
      response.request().method() === 'POST',
  );
  await review.getByRole('button', { name: 'Handled, no action' }).click();
  expect((await resolved).status()).toBe(200);
  await expect(review.getByTestId('disposition')).toContainText(
    'Closed without action by owner: Already paid',
  );
  await expect(review.getByRole('combobox', { name: 'Handler' })).toHaveCount(
    0,
  );
  const resolvedList = await (
    await page.request.get('/api/list?state=resolved')
  ).json();
  expect(
    resolvedList.items.map((entry: { item: { id: string } }) => entry.item.id),
  ).toEqual([paidId]);
  // The fixture answers refusals with the safe message plus the gate's reason.
  const refused = {
    error: 'Review unavailable; refresh current state',
    reason: 'Item resolved',
  };
  const resolveAgain = await page.request.post('/api/resolve', {
    headers: { 'x-review-csrf': await csrf(page) },
    data: {
      itemId: paidId,
      disposition: 'resolve_no_action',
      requestId: randomUUID(),
    },
  });
  expect(resolveAgain.status()).toBe(409);
  expect(await resolveAgain.json()).toEqual(refused);
  const startAfterResolve = await page.request.post('/api/startAction', {
    headers: { 'x-review-csrf': await csrf(page) },
    data: {
      itemId: paidId,
      handlerId: '@happyvertical/smrt-ingestion-reference:create-draft',
      handlerVersion: '1',
      args: { title: 'Late', body: 'Late' },
      requestId: randomUUID(),
    },
  });
  expect(startAfterResolve.status()).toBe(409);
  expect(await startAfterResolve.json()).toEqual(refused);
  const reloaded = await (
    await page.request.get(`/api/load?itemId=${paidId}`)
  ).json();
  // The item DTO carries only the state; reviewer and reason ride the review view.
  expect(Object.keys(reloaded.entry.item.disposition).sort()).toEqual([
    'at',
    'state',
  ]);
  expect(reloaded.disposition).toMatchObject({
    kind: 'resolved_no_action',
    reviewer: 'owner',
    reason: 'Already paid',
  });
  expect(reloaded.reviews.actions).toHaveLength(0);
  // No CSRF token: neither reviewer operation is accepted.
  expect(
    (
      await page.request.post('/api/resolve', {
        data: {
          itemId,
          disposition: 'resolve_no_action',
          requestId: randomUUID(),
        },
      })
    ).status(),
  ).toBe(403);
});

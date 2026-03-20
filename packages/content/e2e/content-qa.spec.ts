import { expect, test, type Page } from '@playwright/test';

function uniqueSlug(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function trackPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

test('workspace route supports governed editing and published article viewing', async ({
  page,
}) => {
  const pageErrors = trackPageErrors(page);
  const articleTitle = `Governed browser article ${uniqueSlug('workspace')}`;

  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Contents', exact: true }),
  ).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Content QA navigation' });
  await expect(nav.getByRole('link', { name: 'Workspace' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Governance QA' })).toBeVisible();
  await expect(
    nav.getByRole('link', { name: 'Contribution QA' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Add governed article' }).click();

  await expect(
    page.getByRole('heading', { name: 'Add New Content' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Facts' })).toBeVisible();

  await page.locator('#content-edit-form').getByLabel('Title:').fill(articleTitle);
  await page
    .locator('#content-edit-form')
    .getByLabel('Body:')
    .fill('This governed article was created by the Playwright browser suite.');
  await page
    .getByLabel('Description:')
    .fill('Browser-created governed content for QA coverage.');
  await page.getByLabel('Status:').selectOption('published');

  await page.getByRole('button', { name: 'Update Content' }).click();

  await page.getByPlaceholder('Search contents...').fill(articleTitle);
  await expect(page.getByText(articleTitle)).toBeVisible();
  await page.getByRole('link', { name: 'View Article' }).click();

  await expect(
    page.getByRole('heading', { name: articleTitle }),
  ).toBeVisible();
  await expect(page.getByText('How this article was made')).toBeVisible();
  await expect(page.getByText('Back to content workspace')).toBeVisible();

  await page.getByRole('link', { name: 'Back to content workspace' }).click();
  await expect(
    page.getByRole('heading', { name: 'Contents', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Governance QA' }).click();
  await expect(
    page.getByRole('heading', { name: 'Governance Admin' }),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('governance admin persists policy, profile, and assignment overrides', async ({
  page,
}) => {
  const pageErrors = trackPageErrors(page);
  const slug = uniqueSlug('governance');
  const policyKey = `${slug}-policy`;
  const policyLabel = `Policy ${slug}`;
  const profileKey = `${slug}-profile`;
  const profileLabel = `Profile ${slug}`;
  const assignmentLabel = `Assignment ${slug}`;
  const assignmentType = `${slug}-content`;

  await page.goto('/governance');

  await expect(
    page.getByRole('heading', { name: 'Governance Admin' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Add policy' }).click();
  await page.getByLabel('Key').fill(policyKey);
  await page.getByLabel('Label').fill(policyLabel);
  await page.getByLabel('Kind').selectOption('custom');
  await page
    .getByLabel('Instructions')
    .fill('Require a newsroom-style browser QA review.');
  await page.getByRole('button', { name: 'Save policy' }).click();

  await expect(page.getByText(policyLabel)).toBeVisible();
  await expect(page.getByText(`${policyKey} · custom`)).toBeVisible();

  await page.getByRole('button', { name: 'Add profile' }).click();
  await page.getByLabel('Key').fill(profileKey);
  await page.getByLabel('Label').first().fill(profileLabel);
  await page
    .getByLabel('Description')
    .fill('Browser QA profile with a custom blocking review.');
  await page.getByLabel('Policy').selectOption(policyKey);
  await page.getByLabel('Label').nth(1).fill('Browser QA gate');
  await page.getByLabel('Blocking').check();
  await page.getByRole('button', { name: 'Save profile' }).click();

  await expect(page.getByText(profileLabel)).toBeVisible();
  await expect(
    page.getByText(`${profileKey} · 1 requirement(s)`),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Add assignment' }).click();
  await page.getByLabel('Label').fill(assignmentLabel);
  await page.getByLabel('Content type').fill(assignmentType);
  await page.getByLabel('Publication profile').selectOption(profileKey);
  await page.getByLabel('Correction profile').selectOption(profileKey);
  await page.getByLabel('Enforce publish readiness').check();
  await page.getByRole('button', { name: 'Save assignment' }).click();

  await expect(page.getByText(assignmentLabel)).toBeVisible();
  await expect(page.getByText(assignmentType)).toBeVisible();

  await page.reload();

  await expect(page.getByText(policyLabel)).toBeVisible();
  await expect(page.getByText(profileLabel)).toBeVisible();
  await expect(page.getByText(assignmentLabel)).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('contribution QA route supports submission, moderation, promotion, and workspace visibility', async ({
  page,
}) => {
  const pageErrors = trackPageErrors(page);
  const slug = uniqueSlug('contribution');
  const typeKey = `${slug}-letter`;
  const typeLabel = `Letter ${slug}`;
  const contributorEmail = `${slug}@example.com`;
  const contributorName = `Contributor ${slug}`;
  const revisionTitle = `Needs changes ${slug}`;
  const promotedTitle = `Promoted contribution ${slug}`;

  await page.goto('/contributions');

  await expect(
    page.getByRole('heading', { name: 'Contribution Intake and Review' }),
  ).toBeVisible();

  const typesSection = page.locator('section', {
    has: page.getByRole('heading', { name: 'Contribution types' }),
  });
  await typesSection.getByRole('button', { name: 'Add type' }).click();
  await typesSection.getByLabel('Key').fill(typeKey);
  await typesSection.getByLabel('Label').fill(typeLabel);
  await typesSection.getByLabel('Allow files').check();
  await typesSection.getByLabel('Allow empty text').check();
  await typesSection.getByLabel('Promotion content type').fill('article');
  await typesSection.getByLabel('Promotion status').selectOption('draft');
  await typesSection.getByRole('button', { name: 'Save type' }).click();

  await expect(page.getByText(`Saved contribution type "${typeLabel}".`)).toBeVisible();
  await expect(typesSection.getByText(typeLabel)).toBeVisible();

  const contributorsSection = page.locator('section', {
    has: page.getByRole('heading', { name: 'Contributor trust' }),
  });
  await contributorsSection.getByRole('button', { name: 'Add contributor' }).click();
  await contributorsSection.getByLabel('Email').fill(contributorEmail);
  await contributorsSection.getByLabel('Name').fill(contributorName);
  await contributorsSection.getByLabel('Trust level').selectOption('trusted');
  await contributorsSection.getByRole('button', { name: 'Save contributor' }).click();

  await expect(
    page.getByText(`Saved contributor "${contributorName}".`),
  ).toBeVisible();
  await expect(contributorsSection.getByText(contributorName)).toBeVisible();
  await expect(
    contributorsSection
      .locator('article', { hasText: contributorName })
      .getByText(/^trusted$/),
  ).toBeVisible();

  const submissionSection = page.locator('section', {
    has: page.getByRole('heading', { name: 'Contributor submission' }),
  });
  await submissionSection.getByLabel('Contribution type').selectOption(typeKey);
  await submissionSection.getByLabel('Email').fill(contributorEmail);
  await submissionSection.getByLabel('Name').fill(contributorName);
  await submissionSection.getByLabel('Title').fill(revisionTitle);
  await submissionSection
    .getByLabel('Description')
    .fill('Initial browser contribution that should go through changes.');
  await submissionSection
    .getByLabel('Body')
    .fill('Please review this contribution and request revisions.');
  await submissionSection.getByLabel('Attach files').setInputFiles({
    name: 'evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('browser-held attachment'),
  });
  await submissionSection
    .getByRole('button', { name: 'Submit to holding queue' })
    .click();

  await expect(page.getByText(`Submitted "${revisionTitle}"`)).toBeVisible();

  const portalSection = page.locator('section', {
    has: page.getByRole('heading', { name: 'Contributor portal' }),
  });
  await portalSection
    .getByPlaceholder('contributor@example.com')
    .fill(contributorEmail);
  await portalSection.getByRole('button', { name: 'Load' }).click();
  await expect(
    portalSection.getByRole('button', { name: new RegExp(revisionTitle) }),
  ).toBeVisible();

  const inboxSection = page.locator('section', {
    has: page.getByRole('heading', { name: 'Editorial inbox' }),
  });
  await inboxSection.getByRole('button', { name: new RegExp(revisionTitle) }).click();
  await inboxSection
    .getByLabel('Editorial note')
    .fill('Please clarify the opening paragraph.');
  await inboxSection.getByRole('button', { name: 'Request changes' }).click();

  await expect(
    page.getByText(`Requested changes for "${revisionTitle}".`),
  ).toBeVisible();
  await expect(portalSection.getByText('Please clarify the opening paragraph.')).toBeVisible();

  await submissionSection.getByLabel('Contribution type').selectOption(typeKey);
  await submissionSection.getByLabel('Email').fill(contributorEmail);
  await submissionSection.getByLabel('Name').fill(contributorName);
  await submissionSection.getByLabel('Title').fill(promotedTitle);
  await submissionSection
    .getByLabel('Description')
    .fill('A browser contribution that should auto-promote after approval.');
  await submissionSection
    .getByLabel('Body')
    .fill('This contribution should end up as draft content.');
  await submissionSection.getByLabel('Attach files').setInputFiles([]);
  await submissionSection
    .getByRole('button', { name: 'Submit to holding queue' })
    .click();

  await expect(page.getByText(`Submitted "${promotedTitle}"`)).toBeVisible();

  await inboxSection.getByRole('button', { name: new RegExp(promotedTitle) }).click();
  await inboxSection
    .getByLabel('Editorial note')
    .fill('Approved by browser E2E.');
  await inboxSection.getByRole('button', { name: 'Approve' }).click();

  await expect(
    page.getByText(`Approved "${promotedTitle}" into draft.`),
  ).toBeVisible();

  await portalSection
    .getByPlaceholder('contributor@example.com')
    .fill(contributorEmail);
  await portalSection.getByRole('button', { name: 'Load' }).click();
  await expect(
    portalSection.getByRole('button', { name: new RegExp(promotedTitle) }),
  ).toBeVisible();
  await expect(
    portalSection
      .locator('article', { hasText: promotedTitle })
      .getByText(/^promoted$/),
  ).toBeVisible();

  await page.goto('/');
  await page.getByPlaceholder('Search contents...').fill(promotedTitle);
  await expect(page.getByText(promotedTitle)).toBeVisible();

  expect(pageErrors).toEqual([]);
});

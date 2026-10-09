import { expect, test } from '@playwright/test';

test('notification bell marks read and replaces actor state', async ({
  page,
}) => {
  await page.goto('/notifications.html');
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(page.getByText('First user notification')).toBeVisible();
  await page.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Mark all read' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Switch user' }).click();
  await expect(page.getByText('Second user notification')).toBeVisible();
  await expect(page.getByText('First user notification')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(
    page.getByRole('button', { name: 'Mark all read' }),
  ).toBeDisabled();
});

test('mailbox fixture reads email and reports a mock send without network delivery', async ({
  page,
}) => {
  await page.goto('/notifications.html');
  await page.getByText('Welcome to your mailbox', { exact: true }).click();
  await expect(
    page.getByText('Open this message, or compose a mock reply.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.getByLabel('To', { exact: true }).fill('recipient@example.com');
  await page.getByLabel('To', { exact: true }).press('Enter');
  await page
    .getByPlaceholder('Subject', { exact: true })
    .fill('Browser fixture');
  await page.getByPlaceholder('Write your message...').fill('Only a mock.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'No email was delivered.',
  );
});

import { expect, test } from '@playwright/test';
test('functional keyboard application form, inert resource text, and mobile width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Name' }).fill('Synthetic');
  await page
    .getByRole('combobox', { name: 'Resource' })
    .selectOption('resource://opaque/one');
  expect(await page.locator('img').count()).toBe(0);
  const submitted = page.waitForRequest((r) => r.url().endsWith('/submit'));
  await page.getByRole('button', { name: 'Submit input' }).focus();
  await page.keyboard.press('Enter');
  expect((await submitted).postDataJSON()).toEqual({
    action: 'accept',
    content: {
      name: 'Synthetic',
      enabled: false,
      resource: 'resource://opaque/one',
    },
  });
  await expect(page.getByRole('status')).toContainText(
    'application review page',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
for (const action of ['Cancel', 'Decline'])
  test(`${action} submits no domain input`, async ({ page }) => {
    await page.goto('/');
    const request = page.waitForRequest((r) => r.url().endsWith('/submit'));
    await page.getByRole('button', { name: action, exact: true }).click();
    expect((await request).postDataJSON()).toEqual({
      action: action.toLowerCase(),
    });
  });
test('upstream failure leaves usable form and disposal removes listeners surface', async ({
  page,
}) => {
  await page.goto('/?mode=failure');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('not submitted');
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => (window as any).dispose());
  await expect(page.locator('form')).toHaveCount(0);
});
test('invalid required input cannot submit', async ({ page }) => {
  await page.goto('/');
  let calls = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/submit')) calls++;
  });
  await page.getByRole('button', { name: 'Submit input' }).click();
  expect(calls).toBe(0);
});

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

for (const control of ['select', 'text']) {
  test(`${control}: untouched optional array is omitted`, async ({ page }) => {
    await page.goto(`/?mode=array&control=${control}`);
    const request = page.waitForRequest((r) => r.url().endsWith('/submit'));
    await page.getByRole('button', { name: 'Submit input' }).click();
    expect((await request).postDataJSON()).toEqual({ action: 'accept', content: {} });
  });
  for (const empty of [false, true]) {
    test(`${control}: explicit empty selection respects minItems (empty=${empty})`, async ({ page }) => {
      await page.goto(`/?mode=array&control=${control}${empty ? '&empty' : ''}`);
      const input = page.getByLabel('Values', { exact: true });
      if (control === 'select') {
        await input.selectOption('one');
        await input.selectOption([]);
      } else {
        await input.fill('one');
        await input.fill('');
      }
      let calls = 0;
      page.on('request', (r) => { if (r.url().endsWith('/submit')) calls++; });
      const request = empty ? page.waitForRequest((r) => r.url().endsWith('/submit')) : undefined;
      await page.getByRole('button', { name: 'Submit input' }).click();
      if (request) expect((await request).postDataJSON()).toEqual({ action: 'accept', content: { values: [] } });
      else {
        await expect(page.getByRole('status')).toContainText('Check the form values');
        expect(calls).toBe(0);
      }
    });
  }
  test(`${control}: untouched required array is validated`, async ({ page }) => {
    await page.goto(`/?mode=array&control=${control}&required`);
    let calls = 0;
    page.on('request', (r) => { if (r.url().endsWith('/submit')) calls++; });
    await page.getByRole('button', { name: 'Submit input' }).click();
    await expect(page.getByRole('status')).toContainText('Check the form values');
    expect(calls).toBe(0);
  });
}

for (const value of ['newline', 'empty', 'large']) {
  test(`free string array round-trip ${value}`, async ({ page }) => {
    await page.goto(`/?mode=roundtrip&value=${value}`);
    if (value === 'large') {
      await page.getByRole('textbox', { name: 'Values' }).fill(JSON.stringify(['a'.repeat(3000), 'b'.repeat(3000)]));
      expect(await page.getByRole('textbox', { name: 'Values' }).inputValue()).toBe(JSON.stringify(['a'.repeat(3000), 'b'.repeat(3000)]));
    }
    const request = page.waitForRequest((r) => r.url().endsWith('/submit'));
    await page.getByRole('button', { name: 'Submit input' }).click();
    expect((await request).postDataJSON()).toEqual({ action: 'accept', content: { values: value === 'newline' ? ['a\nb'] : value === 'empty' ? [''] : ['a'.repeat(3000), 'b'.repeat(3000)] } });
  });
}
for (const oneOf of [false, true]) for (const useDefault of [false, true]) {
  test(`optional empty choice survives (oneOf=${oneOf}, default=${useDefault})`, async ({ page }) => {
    await page.goto(`/?mode=empty-choice${oneOf ? '&oneOf' : ''}${useDefault ? '&default' : ''}`);
    if (!useDefault) await page.getByRole('combobox', { name: 'Choice' }).selectOption({ label: 'Empty choice' });
    const request = page.waitForRequest((r) => r.url().endsWith('/submit'));
    await page.getByRole('button', { name: 'Submit input' }).click();
    expect((await request).postDataJSON()).toEqual({ action: 'accept', content: { choice: '' } });
  });
}

test('invalid JSON array and oversized items stay editable without submitting', async ({ page }) => {
  await page.goto('/?mode=array&control=text&empty');
  let calls = 0;
  page.on('request', r => { if (r.url().endsWith('/submit')) calls++; });
  for (const value of ['not an array', '[1]', JSON.stringify(['x'.repeat(4097)])]) {
    await page.getByRole('textbox', { name: 'Values' }).fill(value);
    await page.getByRole('button', { name: 'Submit input' }).click();
    await expect(page.getByRole('status')).toContainText('Check the form values');
    expect(calls).toBe(0);
  }
  await page.getByRole('textbox', { name: 'Values' }).fill('["", "a\\nb"]');
  const request = page.waitForRequest(r => r.url().endsWith('/submit'));
  await page.getByRole('button', { name: 'Submit input' }).click();
  expect((await request).postDataJSON()).toEqual({action: 'accept', content: {values: ['', 'a\nb']}});
});

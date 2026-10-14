import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const cases = ['A', 'B', 'C', 'D', 'E'] as const;
const scopes = ['line', 'document'] as const;
const themes = [
  { name: 'light', colorScheme: 'light' as const, forcedColors: 'none' as const },
  { name: 'dark', colorScheme: 'dark' as const, forcedColors: 'none' as const },
  { name: 'forced', colorScheme: 'light' as const, forcedColors: 'active' as const },
];

function expected(kind: (typeof cases)[number]) {
  if (kind === 'A') return ['GST 5% on', 'PST 7% on', 'Includes discounts of'];
  if (kind === 'B') return ['Includes GST 5% of', 'Includes PST 7% of', 'Subtotal (excl. tax)'];
  if (kind === 'C') return ['Subtotal', 'Total'];
  if (kind === 'D') return ['Customer is exempt: prices unchanged, no tax extracted', 'Total'];
  return ['GST 5% on'];
}

test('v2 money examples A–E render from calculator results across scopes, schemes, and widths', async ({ browser }) => {
  const evidence = process.env.INVOICE_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const kind of cases) for (const scope of scopes) for (const theme of themes) for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: theme.colorScheme, forcedColors: theme.forcedColors });
    await page.goto(`/e2e/invoices/index.html?money=${kind}&scope=${scope}&theme=${theme.colorScheme === 'dark' ? 'dark' : 'light'}`);
    for (const phrase of expected(kind)) await expect(page.getByText(phrase, { exact: false }).first()).toBeVisible();
    if (kind === 'C' || kind === 'D') await expect(page.getByText('Includes GST', { exact: false })).toHaveCount(0);
    if (scope === 'document') await expect(page.getByText('Rounded per document')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (evidence) await page.screenshot({ path: join(evidence, `money-${kind}-${scope}-${theme.name}-${width}.png`), fullPage: true });
    await context.close();
  }
});

test('v2 money interactions confirm mode, preserve input, keep one discount form, and submit native fields', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/e2e/invoices/index.html?money=A&scope=line');
  const unitPrice = page.getByLabel('Unit price', { exact: true });
  await expect(unitPrice).toHaveValue('100.00');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Amounts are').selectOption('inclusive');
  await expect(unitPrice).toHaveValue('100.00');
  await page.getByLabel('Discount type').selectOption('percent');
  await expect(page.getByLabel('Discount', { exact: true })).toHaveValue('');
  await page.getByLabel('Discount', { exact: true }).fill('10');
  await page.getByLabel('Tax code').selectOption('gst');
  await expect(page.locator('[name="lineTaxMode"]')).toHaveValue('override');
  await page.getByLabel('Tax code').selectOption('');
  await expect(page.locator('[name="lineTaxMode"]')).toHaveValue('inherit');
  const sent = page.waitForRequest((request) => request.url().endsWith('/save-money') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Save invoice draft' }).click();
  const body = new URLSearchParams((await sent).postData() ?? '');
  expect(body.get('lineAmountType')).toBe('inclusive');
  expect(body.get('lineDiscountType')).toBe('percent');
  expect(body.get('lineDiscountValue')).toBe('10');
  expect(body.get('lineTaxMode')).toBe('inherit');
  await expect(page.getByLabel('Unit price', { exact: true })).toHaveValue('100.00');
  expect(errors).toEqual([]);
});

test('native v2 money form retains malformed values', async ({ browser }) => {
  const native = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 844 } });
  const page = await native.newPage();
  await page.goto('http://127.0.0.1:5586/native-money?case=A&scope=line');
  await page.getByLabel('Unit price', { exact: true }).fill('bad.price');
  await page.getByRole('button', { name: 'Save invoice draft' }).click();
  await expect(page.getByLabel('Unit price', { exact: true })).toHaveValue('bad.price');
  await expect(page.getByRole('alert')).toContainText('Amounts must be non-negative decimal text');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await native.close();
});

test('frozen v2 money records render stored values with controls disabled', async ({ page }) => {
  await page.goto('/e2e/invoices/index.html?money=B&scope=document&frozen=1');
  await expect(page.getByText('Frozen · SENT')).toBeVisible();
  await expect(page.getByText('Rounded per document')).toBeVisible();
  await expect(page.getByLabel('Amounts are')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save invoice draft' })).toHaveCount(0);
});

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

/** Reviewer-approved #3931 A–E stored-display values. Do not derive these from the calculator. */
const expected: Record<(typeof cases)[number], Record<(typeof scopes)[number], readonly string[]>> = {
  A: {
    line: ['Frozen · SENT', 'Subtotal', '$1,144.98', 'Includes discounts of $90.00', 'GST 5% on $1,144.98', '$57.25', 'PST 7% on $334.98', '$23.45', 'Total', '$1,225.68'],
    document: ['Frozen · SENT', 'Subtotal', '$1,144.98', 'Includes discounts of $90.00', 'GST 5% on $1,144.98', '$57.25', 'PST 7% on $334.98', '$23.45', 'Rounded per document', 'Total', '$1,225.68'],
  },
  B: {
    line: ['Frozen · SENT', 'Total', '$1,144.98', 'Includes GST 5% of $53.52', 'Includes PST 7% of $20.94', 'Includes discounts of $90.00', 'Subtotal (excl. tax)', '$1,070.52'],
    document: ['Frozen · SENT', 'Total', '$1,144.98', 'Includes GST 5% of $53.53', 'Includes PST 7% of $20.94', 'Includes discounts of $90.00', 'Rounded per document', 'Subtotal (excl. tax)', '$1,070.51'],
  },
  C: {
    line: ['Frozen · SENT', 'Subtotal', '$1,144.98', 'Includes discounts of $90.00', 'Total'],
    document: ['Frozen · SENT', 'Subtotal', '$1,144.98', 'Includes discounts of $90.00', 'Rounded per document', 'Total'],
  },
  D: {
    line: ['Frozen · SENT', 'Customer is exempt: prices unchanged, no tax extracted', 'Subtotal', '$1,144.98', 'Includes discounts of $90.00', 'Total'],
    document: ['Frozen · SENT', 'Customer is exempt: prices unchanged, no tax extracted', 'Subtotal', '$1,144.98', 'Includes discounts of $90.00', 'Rounded per document', 'Total'],
  },
  E: {
    line: ['Frozen · SENT', 'Subtotal', '$0.30', 'GST 5% on $0.30', '$0.03', 'PST 7% on $0.30', '$0.03', 'Total', '$0.36'],
    document: ['Frozen · SENT', 'Subtotal', '$0.30', 'GST 5% on $0.30', '$0.02', 'PST 7% on $0.30', '$0.02', 'Rounded per document', 'Total', '$0.34'],
  },
};

function hasTaxRows(kind: (typeof cases)[number]) {
  return kind === 'A' || kind === 'B' || kind === 'E';
}

async function foregroundContrast(page: import('@playwright/test').Page) {
  return page.locator('.money-editor').evaluate((element) => {
    const channels = (value: string) => value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (value: string) => {
      const [red, green, blue] = channels(value);
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };
    const foreground = luminance(getComputedStyle(element).color);
    const background = luminance(getComputedStyle(document.documentElement).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
}

for (const kind of cases) for (const scope of scopes) for (const theme of themes) for (const width of [1280, 375])
test(`v2 money ${kind}/${scope}/${theme.name}/${width} frozen snapshot renders exact stored values`, async ({ browser }) => {
  const evidence = process.env.INVOICE_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: theme.colorScheme, forcedColors: theme.forcedColors });
    await page.goto(`/e2e/invoices/index.html?money=${kind}&scope=${scope}&frozen=1&theme=${theme.colorScheme === 'dark' ? 'dark' : 'light'}`);
    for (const text of expected[kind][scope]) await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    if (!hasTaxRows(kind)) {
      await expect(page.getByText('Includes GST', { exact: false })).toHaveCount(0);
      await expect(page.getByText('Includes PST', { exact: false })).toHaveCount(0);
    }
    if (kind === 'D') await expect(page.getByText('Subtotal (excl. tax)', { exact: false })).toHaveCount(0);
    await expect(page.getByLabel('Amounts are')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Create credit note' })).toBeDisabled();
    if (theme.name === 'dark') expect(await foregroundContrast(page)).toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (evidence) await page.screenshot({ path: join(evidence, `money-${kind}-${scope}-${theme.name}-${width}.png`), fullPage: true });
    await context.close();
});

test('v2 money interactions confirm mode, preserve input, keep one discount form, and submit native fields', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/e2e/invoices/index.html?money=A&scope=line');
  await expect(page.getByTestId('unrelated-form')).toHaveCSS('display', 'block');
  const unitPrice = page.getByLabel('Unit price', { exact: true }).first();
  await expect(unitPrice).toHaveValue('85.00');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Amounts are').selectOption('inclusive');
  await expect(unitPrice).toHaveValue('85.00');
  await page.getByLabel('Discount type').first().selectOption('percent');
  await expect(page.getByLabel('Discount', { exact: true }).first()).toHaveValue('');
  await page.getByLabel('Discount', { exact: true }).first().fill('10');
  await page.getByLabel('Tax code').first().selectOption('gst');
  await expect(page.locator('[name="lineTaxMode"]').first()).toHaveValue('override');
  await page.getByLabel('Tax code').first().selectOption('');
  await expect(page.locator('[name="lineTaxMode"]').first()).toHaveValue('inherit');
  const sent = page.waitForRequest((request) => request.url().endsWith('/save-money') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Save invoice draft' }).click();
  const body = new URLSearchParams((await sent).postData() ?? '');
  expect(body.get('lineAmountType')).toBe('inclusive');
  expect(body.get('lineDiscountType')).toBe('percent');
  expect(body.get('lineDiscountValue')).toBe('10');
  expect(body.get('lineTaxMode')).toBe('inherit');
  await expect(page.getByLabel('Unit price', { exact: true }).first()).toHaveValue('85.00');
  expect(errors).toEqual([]);
});

test('native v2 money form retains malformed values', async ({ browser }) => {
  const native = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 844 } });
  const page = await native.newPage();
  await page.goto('http://127.0.0.1:5586/native-money?case=A&scope=line');
  await page.getByLabel('Unit price', { exact: true }).first().fill('bad.price');
  await page.getByRole('button', { name: 'Save invoice draft' }).click();
  await expect(page.getByLabel('Unit price', { exact: true }).first()).toHaveValue('bad.price');
  await expect(page.getByRole('alert')).toContainText('Amounts must be non-negative decimal text');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await native.close();
});

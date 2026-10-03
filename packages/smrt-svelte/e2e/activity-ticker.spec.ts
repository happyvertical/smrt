import { expect, test } from '@playwright/test';

for (const width of [320, 390, 1280]) {
  test(`single process stays static and footer details fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/activity-ticker.html?count=1');
    const region = page.getByRole('region', { name: 'Running processes' });
    await expect(region.getByRole('listitem')).toHaveText(
      'Native process 1 · 40%',
    );
    await expect(region.locator('.smrt-activity-ticker__track')).toHaveCSS(
      'animation-name',
      'none',
    );
    await expect(
      page.getByRole('button', { name: 'Pause scrolling activities' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Toggle activity details' }).click();
    await expect(page.locator('.smrt-activity-item')).toHaveCount(1);
    await expect(page.locator('.smrt-activity-item')).toContainText(
      'Activity detail 1',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Toggle activity details' }).click();
    await expect(page.locator('.smrt-activity-item')).not.toBeVisible();
  });
}
test('multiple processes scroll, pause persistently by keyboard, and expose each accessible label once', async ({
  page,
}) => {
  await page.goto('/activity-ticker.html?count=3');
  const region = page.getByRole('region', { name: 'Running processes' });
  await expect(region.getByRole('listitem')).toHaveCount(3);
  const track = region.locator('.smrt-activity-ticker__track');
  await expect(track).toHaveAttribute('aria-hidden', 'true');
  await expect(track).toHaveCSS('animation-name', /smrt-activity-scroll$/);
  await expect(track).toHaveCSS('animation-play-state', 'running');
  await region.hover();
  await expect(track).toHaveCSS('animation-play-state', 'paused');
  await page.getByRole('button', { name: 'Toggle activity details' }).hover();
  await expect(track).toHaveCSS('animation-play-state', 'running');
  const pause = page.getByRole('button', {
    name: 'Pause scrolling activities',
  });
  await pause.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Resume scrolling activities' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle activity details' }).focus();
  await expect(track).toHaveCSS('animation-play-state', 'paused');
});
test('reduced motion removes animation and duplicate text while keeping stable accessible activities', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/activity-ticker.html?count=3');
  const region = page.getByRole('region', { name: 'Running processes' });
  await expect(region.getByRole('listitem')).toHaveCount(3);
  await expect(region.locator('.smrt-activity-ticker__track')).toHaveCSS(
    'animation-name',
    'none',
  );
  await expect(region.locator('.smrt-activity-ticker__copy')).not.toBeVisible();
  await page.getByRole('button', { name: 'Toggle activity details' }).click();
  await expect(page.locator('.smrt-activity-item')).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('empty feed tells the truth in both collapsed and expanded states', async ({
  page,
}) => {
  await page.goto('/activity-ticker.html?count=0');
  await expect(
    page.getByRole('region', { name: 'Running processes' }),
  ).toHaveText('No active processes');
  await page.getByRole('button', { name: 'Toggle activity details' }).click();
  await expect(page.locator('.smrt-activity-list__empty')).toHaveText(
    'No active processes',
  );
});

test('queued work is active with an accurate label, while terminal work only appears in expanded details', async ({
  page,
}) => {
  await page.goto('/activity-ticker.html?count=3&queued=1&terminal=1');
  const region = page.getByRole('region', { name: 'Active processes' });
  await expect(region.getByRole('listitem')).toHaveCount(2);
  await expect(region.getByRole('listitem').first()).toHaveText(
    'Queued · Native process 1',
  );
  await expect(region).not.toContainText('Native process 3');
  await expect(region.locator('.smrt-activity-ticker__track')).toHaveCSS(
    'animation-name',
    /smrt-activity-scroll$/,
  );
  await page.getByRole('button', { name: 'Toggle activity details' }).click();
  await expect(page.locator('.smrt-activity-item')).toHaveCount(3);
  await expect(
    page.locator('.smrt-activity-item[data-status="queued"]'),
  ).toContainText('Native process 1');
  await expect(
    page.locator('.smrt-activity-item[data-status="completed"]'),
  ).toContainText('Native process 3');
});

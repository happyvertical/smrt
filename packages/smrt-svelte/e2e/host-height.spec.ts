import { expect, test } from '@playwright/test';

// A host container of its own height (#4416): the shell, behind its own
// ThemeProvider root, ends exactly at the container's bottom, and only the
// shell's regions scroll.
for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`shell fills a 600px host container at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?host-height');
    const frame = page.locator('.host-frame');
    const shell = page.locator('.smrt-admin-shell');
    await expect(shell).toBeVisible();
    if (viewport.width <= 768) {
      // The phone bottom-bar branch (100dvh by default) honours the property too.
      await expect(shell).toHaveAttribute('data-bottom-bar', /nav|form/);
    }
    const frameBox = await frame.boundingBox();
    const shellBox = await shell.boundingBox();
    if (!frameBox || !shellBox) throw new Error('Missing bounds');
    expect(frameBox.height).toBe(600);
    expect(shellBox.y).toBeCloseTo(frameBox.y, 0);
    expect(shellBox.height).toBeCloseTo(600, 0);
    expect(shellBox.y + shellBox.height).toBeCloseTo(
      frameBox.y + frameBox.height,
      0,
    );
    // The page itself does not scroll.
    const pageOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollHeight -
        document.documentElement.clientHeight,
    );
    expect(pageOverflow).toBe(0);
    // Long content scrolls inside main, not the shell.
    const main = page.locator('.smrt-admin-shell__main');
    const overflow = await main.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    expect(overflow).toBeGreaterThan(0);
  });
}

test('shell stays viewport-sized without the host property', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?tabs');
  const box = await page.locator('.smrt-admin-shell').boundingBox();
  expect(box?.height).toBeCloseTo(900, 0);
});

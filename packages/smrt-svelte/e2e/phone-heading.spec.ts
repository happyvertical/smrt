import { expect, test } from '@playwright/test';

for (const width of [320, 390, 768, 1024]) {
  for (const kind of ['action', 'home', 'detail', 'custom']) {
    test(`phone heading remains represented for ${kind} chrome at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/phone-heading.html?kind=${kind}`);
      const heading = page.getByRole('heading', {
        name: 'Construction project',
        level: 1,
      });
      await expect(heading).toHaveCount(1);
      const height = await heading.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      if (width <= 768 && (kind === 'detail' || kind === 'custom')) {
        expect(height).toBe(1);
        await expect(
          page.locator('[data-shell-page-title-replacement]'),
        ).toBeVisible();
      } else {
        expect(height).toBeGreaterThan(1);
      }
      const crumbs = page.getByRole('navigation', {
        name: 'Breadcrumb',
        includeHidden: true,
      });
      if (width <= 768 && kind === 'detail') {
        await expect(crumbs).toBeHidden();
        await expect(
          page.getByRole('link', { name: 'Back to Projects' }),
        ).toHaveAttribute('href', '/projects');
      } else {
        await expect(crumbs).toBeVisible();
        await expect(
          crumbs.getByRole('link', { name: 'Projects' }),
        ).toHaveAttribute('href', '/projects');
      }
      if (width <= 768 && kind === 'action') {
        const accountMenu = page.getByRole('button', {
          name: /Open account menu Dana Welder/,
        });
        await accountMenu.click();
        await expect(
          page.getByRole('menuitem', { name: 'Sign out' }),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        const assistant = page.getByRole('button', {
          name: 'Assistant',
          exact: true,
        });
        await expect
          .poll(() =>
            assistant.evaluate((button) => {
              const box = button.getBoundingClientRect();
              const target = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
              return target === button || button.contains(target);
            }),
          )
          .toBe(true);
        await page
          .getByRole('button', { name: 'Assistant', exact: true })
          .click();
        await expect(page.getByText('Assistant opened')).toBeVisible();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    });
  }
}

for (const scheme of ['light', 'dark']) {
  test(`action chrome obscures scrolled content in ${scheme} mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/phone-heading.html?kind=action&scroll=1&scheme=${scheme}`,
    );
    const shell = page.locator('.smrt-admin-shell');
    const main = page.locator('.smrt-admin-shell__main');
    await main.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(shell).toHaveAttribute('data-chrome-hidden', '');
    await main.evaluate((element) => {
      element.scrollTop -= 180;
    });
    await expect(shell).not.toHaveAttribute('data-chrome-hidden', '');
    const colors = await page
      .locator('.smrt-admin-shell__phone-top')
      .evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        surface: getComputedStyle(element)
          .getPropertyValue('--smrt-color-surface')
          .trim(),
      }));
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.surface).not.toBe('');
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(page.getByText('Assistant opened')).toHaveCount(1);
  });
}

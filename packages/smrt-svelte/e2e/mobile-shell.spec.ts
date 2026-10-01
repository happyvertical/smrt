import { expect, test } from '@playwright/test';

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 667, height: 375 },
  { width: 1280, height: 800 },
]) {
  for (const left of ['collapsed', 'expanded', 'hidden']) {
    for (const right of ['collapsed', 'expanded', 'hidden']) {
      test(`${viewport.width}px overlays with ${left} left / ${right} right`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        for (const edge of ['top', 'bottom']) {
          await page.goto(`/?left=${left}&right=${right}&${edge}=expanded`);
          const drawer = page.locator(`.smrt-admin-shell__drawer--${edge}`);
          await expect(drawer).toBeVisible();
          if (edge === 'top') {
            expect(
              await drawer.evaluate(
                (element) => element.scrollWidth - element.clientWidth,
              ),
            ).toBeLessThanOrEqual(1);
          }
          const box = await drawer.boundingBox();
          if (!box) throw new Error('Missing drawer bounds');
          const shell = page.locator('.smrt-admin-shell');
          const tracks = await shell.evaluate((element) => {
            const columns = getComputedStyle(element)
              .gridTemplateColumns.split(' ')
              .map(Number.parseFloat);
            return { left: columns[0], right: columns[2] };
          });
          expect(box.x).toBeCloseTo(
            edge === 'bottom' || viewport.width <= 768 ? 0 : tracks.left,
            0,
          );
          expect(box.x + box.width).toBeCloseTo(
            viewport.width -
              (edge === 'bottom' || viewport.width <= 768 ? 0 : tracks.right),
            0,
          );
          const header = await page
            .locator('.smrt-admin-shell__edge--top')
            .boundingBox();
          const footer = await page
            .locator('.smrt-admin-shell__edge--bottom')
            .boundingBox();
          if (!header || !footer) throw new Error('Missing shell bands');
          if (viewport.width <= 768) {
            expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
            expect(box.y + box.height).toBeLessThanOrEqual(footer.y + 1);
            for (const [side, state] of [
              ['left', left],
              ['right', right],
            ]) {
              const panel = page.locator(`.smrt-admin-shell__edge--${side}`);
              if (state === 'hidden') {
                await expect(panel).toHaveCount(0);
              } else if (state === 'expanded') {
                await expect(panel).toBeInViewport();
                const panelBox = await panel.boundingBox();
                expect(panelBox?.y).toBeCloseTo(header.y + header.height, 0);
                expect(
                  (panelBox?.y ?? 0) + (panelBox?.height ?? 0),
                ).toBeCloseTo(footer.y, 0);
              } else {
                await expect(panel).not.toBeInViewport();
              }
            }
          }
        }
      });
    }
  }
}

test('the collapsed system bar stays a full-width application footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const left of ['collapsed', 'expanded', 'hidden']) {
    for (const right of ['collapsed', 'expanded', 'hidden']) {
      await page.goto(`/?left=${left}&right=${right}&bottom=collapsed`);
      const footer = page.locator('.smrt-admin-shell__edge--bottom');
      const box = await footer.boundingBox();
      if (!box) throw new Error('Missing footer bounds');
      expect(box.x).toBeCloseTo(0, 0);
      expect(box.width).toBeCloseTo(1280, 0);
    }
  }
});

test('the expanded system footer is on top of the side panes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?left=expanded&right=expanded&bottom=expanded');
  const drawer = page.locator('.smrt-admin-shell__drawer--bottom');
  await expect(drawer).toBeVisible();
  await page.waitForTimeout(200);
  const box = await drawer.boundingBox();
  if (!box) throw new Error('Missing bottom drawer bounds');
  expect(
    await page.evaluate(
      ({ x, y }) =>
        (() => {
          const hit = document.elementFromPoint(x, y);
          return (
            hit !== null &&
            hit.closest('.smrt-admin-shell__drawer--bottom') !== null
          );
        })(),
      { x: 8, y: box.y + 8 },
    ),
  ).toBe(true);
});

test('status chips stay in the footer and scroll to the final chip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  const chips = page.locator('.smrt-system-status-chips');
  await expect(chips).toBeVisible();
  const box = await chips.boundingBox();
  const footer = await page
    .locator('.smrt-admin-shell__edge--bottom')
    .boundingBox();
  if (!box || !footer) throw new Error('Missing footer bounds');
  expect(box.y).toBeGreaterThanOrEqual(footer.y);
  expect(box.y + box.height).toBeLessThanOrEqual(footer.y + footer.height);
  const client = await page.context().newCDPSession(page);
  try {
    for (let gesture = 0; gesture < 5; gesture++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: box.x + box.width - 10, y: box.y + box.height / 2 }],
      });
      for (let step = 1; step <= 12; step++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: box.x + box.width - 10 - ((box.width - 20) * step) / 12,
              y: box.y + box.height / 2,
            },
          ],
        });
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    }
    await expect(chips.getByText('Status 8', { exact: true })).toBeInViewport({
      ratio: 1,
    });
    expect(
      await chips.evaluate((element) => element.scrollLeft),
    ).toBeGreaterThan(30);
  } finally {
    await client.detach();
  }
});

for (const width of [390, 1280]) {
  test(`brand link remains visible and focusable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?brand=1');
    const home = page
      .locator('header')
      .getByRole('link', { name: 'Mobile shell fixture' });
    await expect(home).toBeInViewport();
    await expect(home).toHaveAttribute('href', '/home');
    await page.keyboard.press('Tab');
    await expect(home).toBeFocused();
    expect(
      await home.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).not.toBe('none');
    if (width > 768) {
      const compact = page.locator(
        '.smrt-admin-shell__edge--left .smrt-admin-shell__brand-link',
      );
      await expect(compact).toBeInViewport();
      const mark = await compact.boundingBox();
      const rail = await page
        .locator('.smrt-admin-shell__edge--left')
        .boundingBox();
      expect(mark!.width).toBeLessThanOrEqual(rail!.width);
    }
  });
}

test('bottom drawer stays inside the main area during animation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.addInitScript(() => {
    document.addEventListener('animationstart', (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.classList.contains('smrt-admin-shell__drawer--bottom')
      )
        return;
      const animation = (event.target as HTMLElement).getAnimations()[0];
      if (!animation) return;
      animation.pause();
      animation.currentTime =
        Number(animation.effect?.getTiming().duration) / 2;
    });
  });
  await page.goto('/?left=expanded&right=expanded&bottom=expanded');
  const drawer = page.locator('.smrt-admin-shell__drawer--bottom');
  await expect(drawer).toBeVisible();
  await expect
    .poll(() => drawer.evaluate((el) => el.getAnimations()[0]?.playState))
    .toBe('paused');
  const box = await drawer.boundingBox();
  const footer = await page
    .locator('.smrt-admin-shell__edge--bottom')
    .boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(footer!.y + 1);
});

test('narrow navigation opens, restores focus and excludes closed drawer controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  const drawer = page.locator('.smrt-admin-shell__edge--left');
  await expect(drawer).toHaveAttribute('inert', '');
  await expect(drawer).not.toBeVisible();
  await menu.click();
  await expect(drawer).not.toHaveAttribute('inert');
  await expect(
    drawer.getByRole('button', { name: 'Collapse Tenant' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveAttribute('inert', '');
  await expect(menu).toBeFocused();
  await menu.click();
  await drawer.getByRole('link', { name: 'Queue', exact: true }).click();
  await expect(drawer).toHaveAttribute('inert', '');
  await expect(menu).toBeFocused();
  await page.getByRole('button', { name: 'Hide navigation' }).click();
  await expect(drawer).toHaveCount(0);
  await menu.click();
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole('button', { name: 'Collapse Tenant' }),
  ).toBeFocused();
});

test('supplied tenant navigation keeps its collapse control and touch rail targets', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?left=expanded');
  const drawer = page.locator('.smrt-admin-shell__edge--left');
  await drawer.getByRole('button', { name: 'Collapse Tenant' }).click();
  await expect(drawer).toHaveAttribute('data-state', 'collapsed');
  const bounds = await drawer.boundingBox();
  for (const link of await drawer.getByRole('link').all()) {
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(48);
    expect(box!.width).toBeGreaterThanOrEqual(48);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  await expect(
    page.locator('footer').getByRole('button', { name: /^System/ }),
  ).toBeVisible();
});

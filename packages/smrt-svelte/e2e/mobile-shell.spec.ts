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
          expect(box.x).toBeCloseTo(viewport.width <= 768 ? 0 : tracks.left, 0);
          expect(box.x + box.width).toBeCloseTo(
            viewport.width - (viewport.width <= 768 ? 0 : tracks.right),
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

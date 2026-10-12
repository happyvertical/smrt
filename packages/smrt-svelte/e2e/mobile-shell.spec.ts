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
      // With the header showing the brand, the rail does not repeat it (#3798).
      await expect(
        page.locator(
          '.smrt-admin-shell__edge--left .smrt-admin-shell__brand-link',
        ),
      ).toHaveCount(0);
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

test('continuous drawer animations do not block phone focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const drawer = page.locator('.smrt-admin-shell__edge--left');
  await drawer.evaluate((element) => {
    element.animate([{ opacity: 0.9 }, { opacity: 1 }], {
      duration: 1000,
      iterations: Infinity,
    });
  });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect
    .poll(() =>
      drawer.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
});

test('a top-hidden default phone shell keeps its header and one supported menu opener', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?top=hidden&left=collapsed&header=1');
  await expect(page.getByTestId('admin-shell-header')).toHaveText(
    'Consumer header',
  );
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await expect(menu).toHaveCount(1);
  await expect(menu).toHaveAttribute(
    'aria-controls',
    'smrt-admin-shell-left-panel',
  );
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page
      .locator('.smrt-admin-shell__edge--left')
      .getByRole('button', { name: 'Close menu' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
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
    drawer.getByRole('button', { name: 'Close menu' }),
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
    drawer.getByRole('button', { name: 'Close menu' }),
  ).toBeFocused();
});

test('supplied tenant navigation keeps its collapse control and touch rail targets', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?left=expanded');
  const drawer = page.locator('.smrt-admin-shell__edge--left');
  await drawer.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(drawer).toHaveAttribute('data-state', 'collapsed');
  const bounds = await drawer.boundingBox();
  for (const link of await drawer.getByRole('link').all()) {
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(48);
    expect(box!.width).toBeGreaterThanOrEqual(48);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  await expect(
    page.locator('footer').getByRole('button', { name: /^Footer/ }),
  ).toBeVisible();
});

test('sidebar-only chrome keeps brand and account access across rail states', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    '/?top=hidden&left=collapsed&brand=1&account=1&railAccount=1',
  );

  await expect(page.locator('#smrt-admin-shell-top-panel')).toHaveCount(0);
  const rail = page.locator('.smrt-admin-shell__edge--left');
  const account = page.getByRole('button', {
    name: /Open account menu Dana(?: ·)? Welder/,
  });
  await expect(rail.locator('.smrt-admin-shell__brand.compact')).toBeVisible();
  await expect(account).toHaveCount(1);
  await account.click();
  const signOut = page.getByRole('menuitem', { name: 'Sign out' });
  await expect(signOut).toBeInViewport();
  const menuBox = await signOut.boundingBox();
  const railBox = await rail.boundingBox();
  expect(menuBox!.x + menuBox!.width).toBeGreaterThan(
    railBox!.x + railBox!.width,
  );
  await page.keyboard.press('Escape');

  await rail.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(
    rail.locator('.smrt-admin-shell__brand:not(.compact)'),
  ).toContainText('Mobile shell fixture');
  await expect(account).toHaveCount(1);
});

test('a footer-only collapsed rail pins its account control at the bottom', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?top=hidden&left=collapsed&railAccount=1&railFooterOnly=1');

  const left = page.locator('.smrt-admin-shell__edge--left');
  const rail = left.locator('.smrt-admin-shell__rail');
  const footer = rail.locator('.smrt-admin-shell__tenant-rail-footer');
  await expect(
    footer.getByRole('button', { name: /Open account menu Dana/ }),
  ).toBeVisible();
  await expect(footer).toHaveCSS('grid-row-start', '2');
  const railBox = await rail.boundingBox();
  const footerBox = await footer.boundingBox();
  expect(railBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(footerBox!.y).toBeGreaterThan(railBox!.y + railBox!.height / 2);
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(
    railBox!.y + railBox!.height,
  );
});

for (const width of [320, 390, 1280]) {
  test(`account stays reachable with touch targets at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?account=1');
    const account = page.getByRole('button', {
      name: /Open account menu Dana Welder/,
    });
    await expect(account).toBeInViewport();
    const box = await account.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(48);
    expect(box!.width).toBeGreaterThanOrEqual(48);
    await account.click();
    const signOut = page.getByRole('menuitem', { name: 'Sign out' });
    await expect(signOut).toBeInViewport();
    const item = await signOut.boundingBox();
    expect(item!.height).toBeGreaterThanOrEqual(48);
    await signOut.click();
    await expect(page.getByText('Signed out callback')).toBeVisible();
    await expect(account).toHaveCount(1);
    if (width <= 768) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(account).toHaveCount(1);
      await expect(account).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(account).toBeInViewport();
    }
  });
}

test('grouped navigation keeps labelled keyboard-collapsible touch controls in the rail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?groups=1');
  const nav = page.getByRole('navigation', {
    name: 'Shop navigation',
    exact: true,
  });
  const floor = nav.getByRole('group', { name: 'Floor', exact: true });
  const summary = floor.locator('summary');
  await expect(summary).toHaveAccessibleName('Floor');
  const bounds = await summary.boundingBox();
  expect(bounds!.width).toBeGreaterThanOrEqual(48);
  expect(bounds!.height).toBeGreaterThanOrEqual(48);
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(floor.getByRole('link', { name: 'Orders' })).not.toBeVisible();
  await page.keyboard.press('Space');
  await expect(floor.getByRole('link', { name: 'Orders' })).toBeVisible();
  await expect(
    nav
      .getByRole('group', { name: 'Office' })
      .getByRole('link', { name: 'Billing' }),
  ).toBeVisible();
  const rail = await page
    .locator('.smrt-admin-shell__edge--left')
    .boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(rail!.x + rail!.width);
});

test('a phone reaches the right edge through the Tools opener and exclusive drawers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?tool=1');
  const tools = page.getByRole('button', { name: 'Tools', exact: true });
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await expect(tools).toBeVisible();
  const box = await tools.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(box!.height).toBeGreaterThanOrEqual(48);
  await tools.click();
  const right = page.locator('.smrt-admin-shell__edge--right');
  await expect(right).toHaveAttribute('data-state', 'expanded');
  await expect(right).toBeInViewport();
  await expect(page.getByTestId('admin-shell-scrim')).toBeVisible();
  await page
    .getByTestId('admin-shell-scrim')
    .click({ position: { x: 5, y: 400 } });
  await expect(right).toHaveAttribute('data-state', 'collapsed');
  await menu.click();
  await expect(page.locator('.smrt-admin-shell__edge--left')).toHaveAttribute(
    'data-state',
    'expanded',
  );
  await page.getByRole('button', { name: 'Close menu' }).first().click();
  await expect(page.locator('.smrt-admin-shell__edge--left')).toHaveAttribute(
    'data-state',
    'collapsed',
  );
});

test.describe('AppShell phone tab bar (375px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
  });

  test('tab navigation moves the current highlight', async ({ page }) => {
    await page.goto('/?tabs=on');
    const bar = page.getByTestId('phone-bottom-bar');
    await expect(bar).toBeVisible();
    const queue = bar.locator('[data-item="#queue"]');
    const reports = bar.locator('[data-item="#reports"]');
    await reports.click();
    await expect(reports).toHaveAttribute('aria-current', 'page');
    await expect(queue).not.toHaveAttribute('aria-current', 'page');
    await queue.click();
    await expect(queue).toHaveAttribute('aria-current', 'page');
    // Four navigation/dock tabs plus More; touch targets are large enough.
    await expect(bar.locator('[data-item]')).toHaveCount(5);
    const box = await queue.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('the assistant tab opens a sheet above the bar, closes by grabber swipe and Escape', async ({
    page,
  }) => {
    await page.goto('/?tabs=on');
    const bar = page.getByTestId('phone-bottom-bar');
    const tab = bar.locator('[data-item="dock:assistant"]');
    const sheet = page.locator('.smrt-admin-shell__edge--right');
    await expect(sheet).toHaveAttribute('data-phone', 'sheet');
    await tab.click();
    await expect(sheet).toHaveAttribute('data-state', 'expanded');
    const barBox = await bar.boundingBox();
    if (!barBox) throw new Error('Missing bar bounds');
    // The sheet rises into place; it ends above the tab bar, full width.
    await expect
      .poll(async () => {
        const box = await sheet.boundingBox();
        return box ? Math.round(box.y + box.height) : Number.NaN;
      })
      .toBeLessThanOrEqual(Math.round(barBox.y) + 1);
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox?.width ?? 0).toBeGreaterThanOrEqual(374);

    const grabber = page.locator('.smrt-admin-shell__sheet-grabber');
    const g = await grabber.boundingBox();
    if (!g) throw new Error('Missing grabber');
    const x = g.x + g.width / 2;
    const y = g.y + g.height / 2;
    await page.touchscreen.tap(x, y);
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    for (const dy of [30, 80, 140, 200]) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y + dy }],
      });
    }
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect(sheet).not.toHaveAttribute('data-state', 'expanded');

    await tab.click();
    await expect(sheet).toHaveAttribute('data-state', 'expanded');
    await page.keyboard.press('Escape');
    await expect(sheet).not.toHaveAttribute('data-state', 'expanded');
  });

  test('opening Menu from More closes the sheet', async ({ page }) => {
    await page.goto('/?tabs=on');
    const bar = page.getByTestId('phone-bottom-bar');
    const sheet = page.locator('.smrt-admin-shell__edge--right');
    const left = page.locator('.smrt-admin-shell__edge--left');
    await bar.locator('[data-item="dock:assistant"]').click();
    await expect(sheet).toHaveAttribute('data-state', 'expanded');
    await bar.locator('[data-item="more"]').click();
    await expect(left).toHaveAttribute('data-state', 'expanded');
    await expect(sheet).not.toHaveAttribute('data-state', 'expanded');
    await page.getByRole('button', { name: 'Close menu' }).first().click();
    await bar.locator('[data-item="dock:assistant"]').click();
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(left).toHaveAttribute('data-state', 'expanded');
    await expect(sheet).not.toHaveAttribute('data-state', 'expanded');
  });

  test('without the prop there is no tab bar', async ({ page }) => {
    await page.goto('/?tabs=off');
    await expect(page.getByTestId('phone-bottom-bar')).toHaveCount(0);
  });
});

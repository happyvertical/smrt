/**
 * Mount, navigate, unmount — without leaking registrations.
 *
 * A WebMCP registration is owned by the component that made it. Client-side
 * navigation tears that component down and stands it back up; if disposal
 * were missing, the model context would accumulate duplicate live tools and
 * the second registration would silently shadow the first.
 */

import { expect, test } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

test('mount, navigation, and unmount leave no duplicate live registrations', async ({
  ownerPage,
}) => {
  await ownerPage.goto('/', { waitUntil: 'networkidle' });

  const liveNames = async () =>
    (await ownerPage.evaluate(() => window.__m5ModelContext!.live())).map(
      (entry) => entry.name,
    );

  // The shell's tenant rail starts collapsed, so its links are not rendered
  // until the panel is expanded. Expand it once, then navigate within it.
  await ownerPage.getByRole('button', { name: /Tenant/ }).click();
  await expect(ownerPage.getByRole('link', { name: 'Settings' })).toBeVisible();

  const initial = await liveNames();
  expect(new Set(initial).size).toBe(initial.length);
  const registeredBefore = await ownerPage.evaluate(
    () => window.__m5ModelContext!.registrations().length,
  );

  // Client-side navigation, then back. Two full mount/unmount cycles.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await ownerPage.getByRole('link', { name: 'Settings' }).first().click();
    await ownerPage.waitForURL((url) => new URL(url).pathname === '/settings');
    await ownerPage.getByRole('link', { name: 'Items' }).first().click();
    await ownerPage.waitForURL((url) => new URL(url).pathname === '/');
  }

  const after = await liveNames();
  // Same set of tools, still exactly once each.
  expect(new Set(after).size).toBe(after.length);
  expect([...after].sort()).toEqual([...initial].sort());

  // Nothing accumulated. In this application every WebMCP registration is
  // owned by the root layout — the Provider and RuntimeDiagnosticsWebMcp both
  // live there — so navigating between routes under that layout must not tear
  // them down and must not register them again. A component that re-registered
  // per navigation would show up here as a growing total, and as a duplicate
  // live name above.
  //
  // That also means there is no in-document unmount to observe: the only way
  // these owners are torn down is with their document, which the reload test
  // below covers. Disposal on owner teardown itself — `owner.dispose()`
  // aborting the registration signal — is asserted directly in
  // `__tests__/runtimeDiagnostics.test.ts`.
  const all = await ownerPage.evaluate(() =>
    window.__m5ModelContext!.registrations(),
  );
  expect(all.length).toBe(registeredBefore);
  expect(all.filter((entry) => entry.aborted)).toEqual([]);
});

test('a full page reload starts from an empty model context', async ({
  ownerPage,
}) => {
  await ownerPage.goto('/', { waitUntil: 'networkidle' });
  const before = await ownerPage.evaluate(
    () => window.__m5ModelContext!.registrations().length,
  );
  expect(before).toBeGreaterThan(0);

  await ownerPage.reload({ waitUntil: 'networkidle' });
  const afterRecords = await ownerPage.evaluate(() =>
    window.__m5ModelContext!.registrations(),
  );
  // The boundary is rebuilt with the document, so its monotonic counter has
  // to restart. A context carried across the reload would number its first
  // registration after the pre-reload ones instead of at 1.
  expect(afterRecords[0]?.sequence).toBe(1);
  expect(afterRecords.map((entry) => entry.sequence)).toEqual(
    afterRecords.map((_entry, index) => index + 1),
  );
  // A leak across documents would also show as a count that kept climbing.
  expect(afterRecords.length).toBe(before);
});

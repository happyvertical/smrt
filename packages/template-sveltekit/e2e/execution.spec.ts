/**
 * Permitted execution through WebMCP, observed through the normal path.
 *
 * The point of this spec is that the two halves are genuinely the same
 * application: a record written through the generated REST route becomes
 * visible to a WebMCP read executed as the page user, over that page's own
 * session, against that same file-backed database.
 */

import { expect, test } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

/** The generated read tool that fetches one of the template's example rows. */
const ITEM_GET_TOOL = 'item_get';

test('executes a permitted read as the page user and sees persisted state', async ({
  ownerPage,
  referenceApp,
}) => {
  await ownerPage.goto('/', { waitUntil: 'networkidle' });

  const live = await ownerPage.evaluate(() => window.__m5ModelContext!.live());
  expect(live.map((entry) => entry.name)).toContain(ITEM_GET_TOOL);

  const title = `M5 browser gate ${Date.now()}`;
  // Write through the ordinary generated REST route, as the page user. This
  // is the application's own path, not a harness shortcut.
  const created = await ownerPage.request.post(
    `${referenceApp.baseURL}/api/items`,
    { data: { title } },
  );
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect(id).toBeTruthy();

  // Read it back through WebMCP. The tool runs in the page, over the page's
  // session cookie — no service credential, no server-side principal.
  const raw = await ownerPage.evaluate(
    ([tool, rowId]) => window.__m5ModelContext!.execute(tool!, { id: rowId! }),
    [ITEM_GET_TOOL, id],
  );
  const row = JSON.parse(raw) as Record<string, unknown>;
  expect(row.id).toBe(id);
  expect(row.title).toBe(title);

  // ...and the same row is visible through the normal REST list path, so the
  // WebMCP read observed persisted state rather than a client-side cache.
  const list = await ownerPage.request.get(`${referenceApp.baseURL}/api/items`);
  expect(list.status()).toBe(200);
  expect(await list.text()).toContain(title);
});

test('reads authenticated runtime diagnostics through the real route', async ({
  ownerPage,
}) => {
  await ownerPage.goto('/', { waitUntil: 'networkidle' });
  const raw = await ownerPage.evaluate(() =>
    window.__m5ModelContext!.execute('smrt.runtime.diagnostics.read'),
  );
  const diagnostics = JSON.parse(raw) as Record<string, unknown>;

  expect(diagnostics.profile).toBe('local');
  expect(diagnostics.schemaVersion).toBe(1);
  // A stable error shape here would mean the tool never reached the route.
  expect(diagnostics.ok).toBeUndefined();
  expect(diagnostics.health).toBe('healthy');
});

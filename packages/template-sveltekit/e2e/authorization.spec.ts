/**
 * Fail-closed behaviour for anonymous and expired sessions.
 *
 * These contexts get exactly the same WebMCP test boundary as the owner's.
 * The only difference is the session, which is the whole point: authorization
 * is the server's, not the harness's.
 */

import { expect, test } from './fixtures.js';
import { installModelContext } from './support/modelContext.js';

test.describe.configure({ mode: 'serial' });

test('an anonymous context cannot read diagnostics or protected domain data', async ({
  anonymousContext,
  referenceApp,
}) => {
  const page = await anonymousContext.newPage();
  await page.goto('/', { waitUntil: 'networkidle' });

  // The generated REST surface fails closed for an anonymous caller.
  const rest = await page.request.get(`${referenceApp.baseURL}/api/items`);
  expect(rest.status()).toBe(401);

  const diagnostics = await page.request.get(
    `${referenceApp.baseURL}/api/_runtime/diagnostics`,
  );
  expect(diagnostics.status()).toBe(401);
  const body = await diagnostics.text();
  expect(body).toBe('{"schemaVersion":1,"error":{"code":"authentication_required"}}');

  // The diagnostics component is gated on an authenticated session, so an
  // anonymous page must not even carry the tool.
  const live = await page.evaluate(() => window.__m5ModelContext!.live());
  expect(
    live.map((entry) => entry.name),
  ).not.toContain('smrt.runtime.diagnostics.read');
});

test('a forged session fails closed at both boundaries and leaks nothing', async ({
  browser,
  ownerPage,
  referenceApp,
}) => {
  // Depend on the owner fixture so the application is fully provisioned, and
  // create a real row through the owner's own session. Probing an id that was
  // never created — against a database that may not even have an owner yet —
  // would make the WebMCP assertion below true no matter what the server did.
  const title = `Forged-session probe ${Date.now()}`;
  const created = await ownerPage.request.post(
    `${referenceApp.baseURL}/api/items`,
    { data: { title } },
  );
  expect(created.status()).toBe(201);
  const { id: existingId } = (await created.json()) as { id: string };
  expect(existingId).toBeTruthy();

  const context = await browser.newContext({ baseURL: referenceApp.baseURL });
  // Same WebMCP boundary as every other context; only the session differs.
  await context.addInitScript(installModelContext);
  await context.addCookies([
    {
      name: 'sid',
      value: 'expired-session-that-never-existed',
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();

  const diagnostics = await page.request.get(
    `${referenceApp.baseURL}/api/_runtime/diagnostics`,
  );
  expect([401, 403]).toContain(diagnostics.status());
  const body = await diagnostics.text();
  // No projection leaked before authorization.
  expect(body).not.toContain('profile');
  expect(body).not.toContain('capabilities');

  const rest = await page.request.get(`${referenceApp.baseURL}/api/items`);
  expect([401, 403]).toContain(rest.status());

  // The WebMCP half fails closed too: the diagnostics component is gated on an
  // authenticated session, so an unrecognized cookie must not carry the tool —
  // and any generated tool it does carry must not reach protected data.
  await page.goto('/', { waitUntil: 'networkidle' });
  const live = await page.evaluate(() => window.__m5ModelContext!.live());
  expect(live.map((entry) => entry.name)).not.toContain(
    'smrt.runtime.diagnostics.read',
  );
  const attempt = await page.evaluate(async (rowId) => {
    try {
      return await window.__m5ModelContext!.execute('item_get', { id: rowId });
    } catch (error) {
      return `threw: ${(error as Error).message}`;
    }
  }, existingId);
  // The row exists and the owner can read it, so a leak would show here.
  // Either the tool was never registered for this session, or it was and the
  // server refused it — both are refusals; returning the row is the failure.
  expect(attempt).not.toContain(title);
  expect(attempt).toMatch(/^(threw: |\{"ok":false)/);

  await context.close();
});

/**
 * WebMCP discovery in a fresh browser context.
 *
 * The expectation is not restated here: it comes from the canonical
 * cross-profile inventory helpers (#2578), which read the same public
 * generator output the parity snapshots compare. This spec proves that what
 * a real browser receives at runtime equals what those snapshots describe.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './fixtures.js';
import {
  type ExpectedInventory,
  resolveExpectedInventory,
} from './support/parityInventory.js';

test.describe.configure({ mode: 'serial' });

test('registers the bounded domain inventory plus exactly one diagnostic tool', async ({
  referenceApp,
  ownerPage,
}) => {
  const captureRoot = mkdtempSync(
    join(referenceApp.temporaryRoot, 'inventory-'),
  );
  let expected: ExpectedInventory;
  try {
    expected = await resolveExpectedInventory(captureRoot);
  } finally {
    rmSync(captureRoot, { recursive: true, force: true });
  }

  // Both sides of the equality below come from the same generator output, so
  // a change that zeroed the read surface would make it pass vacuously.
  expect(expected.exposedDomainToolNames.length).toBeGreaterThan(0);

  await ownerPage.goto('/', { waitUntil: 'networkidle' });
  const live = await ownerPage.evaluate(() =>
    window.__m5ModelContext!.live(),
  );
  const names = live.map((entry) => entry.name).sort();

  expect(names).toEqual(
    [
      ...expected.exposedDomainToolNames,
      expected.operationalDiagnosticToolName,
    ].sort(),
  );

  // Exactly one operational entry, and it is the authenticated read-only
  // diagnostic — not a second, differently-named diagnostic surface.
  expect(
    names.filter((name) => name === expected.operationalDiagnosticToolName),
  ).toHaveLength(1);

  const diagnostic = live.find(
    (entry) => entry.name === expected.operationalDiagnosticToolName,
  )!;
  expect(diagnostic.annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  expect(diagnostic.inputSchema).toMatchObject({
    type: 'object',
    additionalProperties: false,
  });

  // Effects/approval metadata for every generated tool matches the snapshot.
  for (const tool of expected.domainTools) {
    const registered = live.find((entry) => entry.name === tool.name);
    if (!registered) {
      expect(tool.requiresApproval).toBe(true);
      continue;
    }
    expect(registered.annotations).toMatchObject({
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.effect === 'destructive',
      idempotentHint: tool.idempotent,
      openWorldHint: tool.openWorld,
    });
  }
});

test('exposes the WebMCP boundary and nothing else to the page', async ({
  browser,
  ownerPage,
  ownerStatePath,
  referenceApp,
}) => {
  await ownerPage.goto('/', { waitUntil: 'networkidle' });

  // The one deterministic test boundary is `document.modelContext`. The page
  // must not be able to see any other harness affordance — in particular
  // nothing that would let it bypass the server. Compared against a baseline
  // taken from a context with no init script, so an affordance that simply
  // avoided the `__m5` prefix would still be caught.
  // The baseline is the same application, the same session, and the same load
  // state — differing only in that no init script ran. The delta is therefore
  // exactly what this harness added.
  const baseline = await browser.newContext({
    baseURL: referenceApp.baseURL,
    storageState: ownerStatePath,
  });
  const baselinePage = await baseline.newPage();
  await baselinePage.goto('/', { waitUntil: 'networkidle' });
  const baselineKeys = await baselinePage.evaluate(() => Object.keys(window));
  const baselineHasWebMcp = await baselinePage.evaluate(
    () => 'modelContext' in document,
  );
  await baseline.close();

  // Without the harness there is no WebMCP at all: the boundary is genuinely
  // supplied by this gate and not by the browser.
  expect(baselineHasWebMcp).toBe(false);

  const surface = await ownerPage.evaluate(() => Object.keys(window));
  expect(surface.filter((key) => !baselineKeys.includes(key))).toEqual([
    '__m5ModelContext',
  ]);

  // The diagnostic tool reaches the server over the page session. If the
  // harness had stubbed REST, this request would not exist.
  const [request] = await Promise.all([
    ownerPage.waitForRequest((candidate) =>
      candidate.url().endsWith('/api/_runtime/diagnostics'),
    ),
    ownerPage.evaluate(() =>
      window.__m5ModelContext!.execute('smrt.runtime.diagnostics.read'),
    ),
  ]);
  expect(request.method()).toBe('GET');
});

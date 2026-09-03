/**
 * The consent boundary.
 *
 * Write, external, and destructive operations exist in the generated surface,
 * but a browser page does not get to run them just because a model asked. The
 * template's Provider declares a read-only exposure policy, so those tools are
 * never registered in the first place — and this harness has no confirmation
 * path at all, so nothing here could approve one on the user's behalf.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './fixtures.js';
import {
  type ExpectedInventory,
  resolveExpectedInventory,
} from './support/parityInventory.js';

test.describe.configure({ mode: 'serial' });

test('keeps non-read effects behind their declared consent boundary', async ({
  referenceApp,
  ownerPage,
}) => {
  const captureRoot = mkdtempSync(join(referenceApp.temporaryRoot, 'consent-'));
  let expected: ExpectedInventory;
  try {
    expected = await resolveExpectedInventory(captureRoot);
  } finally {
    rmSync(captureRoot, { recursive: true, force: true });
  }
  // The reference workload declares write and destructive actions; a run
  // where it declared none would prove nothing about the boundary.
  expect(expected.consentGatedDomainToolNames.length).toBeGreaterThan(0);

  await ownerPage.goto('/', { waitUntil: 'networkidle' });
  const registered = await ownerPage.evaluate(() =>
    window.__m5ModelContext!.registrations().map((entry) => entry.name),
  );

  for (const name of expected.consentGatedDomainToolNames) {
    expect(registered).not.toContain(name);
  }

  // Every tool that IS registered is annotated read-only.
  const live = await ownerPage.evaluate(() => window.__m5ModelContext!.live());
  for (const entry of live) {
    expect(entry.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  }
});

test("the harness never self-confirms on the user's behalf", async ({
  ownerPage,
  referenceApp,
}) => {
  const captureRoot = mkdtempSync(
    join(referenceApp.temporaryRoot, 'no-confirm-'),
  );
  let expected: ExpectedInventory;
  try {
    expected = await resolveExpectedInventory(captureRoot);
  } finally {
    rmSync(captureRoot, { recursive: true, force: true });
  }
  // Taken from the canonical #2578 surface, never written as a literal: a
  // hardcoded name that the generator does not produce would make the
  // assertion below self-satisfying.
  const gated = expected.consentGatedDomainToolNames[0];
  expect(gated).toBeTruthy();

  await ownerPage.goto('/', { waitUntil: 'networkidle' });

  // A consent-gated tool is not reachable through the model context at all.
  const attempt = await ownerPage.evaluate(async (name) => {
    try {
      await window.__m5ModelContext!.execute(name!);
      return 'executed';
    } catch (error) {
      return (error as Error).message;
    }
  }, gated);
  expect(attempt).toContain('No live WebMCP tool');

  // The boundary counts confirmations and has never issued one. If a future
  // change taught the harness to approve anything, this would move.
  expect(
    await ownerPage.evaluate(() => window.__m5ModelContext!.confirmations),
  ).toBe(0);

  // The boundary itself offers no approval affordance. A host that could be
  // asked to confirm would be a host that could be asked by the page.
  const affordances = await ownerPage.evaluate(() =>
    Object.keys(
      (document as unknown as { modelContext: object }).modelContext,
    ),
  );
  expect(affordances).toEqual(['registerTool']);
});

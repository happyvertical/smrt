/** Browser session -> confirmation factory -> generated action contract (#3878). */
import {
  parseRuntimeReportSpec,
  runtimeReportSpecHash,
} from '@happyvertical/smrt-reports';
import { expect, test } from './fixtures.js';

test('confirms once and returns enveloped viewer-run and archive results', async ({
  ownerPage,
  anonymousContext,
  referenceApp,
}) => {
  const spec = parseRuntimeReportSpec({
    title: 'Browser note count',
    source: 'notes',
    dimensions: [],
    measures: [{ fn: 'count', as: 'notes' }],
  });
  const specHash = runtimeReportSpecHash(spec);
  const confirmUrl = `${referenceApp.baseURL}/api/_reports/runtime/confirm`;
  const headers = { origin: referenceApp.baseURL };
  const anonymous = await anonymousContext.request.post(confirmUrl, {
    headers,
    data: { spec, specHash },
  });
  expect(anonymous.status()).toBe(401);
  const list = await ownerPage.request.get(
    `${referenceApp.baseURL}/api/runtimereports`,
  );
  expect(list.status()).toBe(200);
  const forged = await ownerPage.request.post(
    `${referenceApp.baseURL}/api/runtimereports`,
    {
      data: {
        title: spec.title,
        sourceId: spec.source,
        specHash,
        spec: JSON.stringify(spec),
        status: 'active',
        confirmed: true,
      },
    },
  );
  expect(forged.status(), await forged.text()).toBe(403);
  const confirmed = await ownerPage.request.post(confirmUrl, {
    headers,
    data: { spec, specHash },
  });
  expect(confirmed.status()).toBe(201);
  const saved = await confirmed.json();
  expect(saved).toEqual({ id: expect.any(String), specHash, title: spec.title });
  const repeated = await ownerPage.request.post(confirmUrl, {
    headers,
    data: { spec, specHash },
  });
  expect(repeated.status()).toBe(200);
  expect(await repeated.json()).toEqual(saved);
  const itemUrl = `${referenceApp.baseURL}/api/runtimereports/${saved.id}`;
  const run = await ownerPage.request.post(`${itemUrl}/run`);
  expect(run.status()).toBe(200);
  expect(await run.json()).toMatchObject({
    action: 'run',
    result: {
      columns: [expect.objectContaining({ id: 'notes', role: 'measure' })],
      rows: [expect.objectContaining({ notes: expect.any(Number) })],
      rowCount: 1,
      truncated: false,
    },
  });
  for (const archived of [true, false]) {
    const response = await ownerPage.request.post(`${itemUrl}/archive`, {
      data: { archived },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      action: 'archive',
      result: {
        id: saved.id,
        status: archived ? 'archived' : 'active',
      },
    });
    if (archived) {
      const archivedRun = await ownerPage.request.post(`${itemUrl}/run`);
      expect(archivedRun.status()).toBe(409);
      expect(await archivedRun.json()).toMatchObject({
        error: { code: 'report_archived' },
      });
    }
  }
});

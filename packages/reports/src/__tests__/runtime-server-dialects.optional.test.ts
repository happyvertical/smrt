import { randomUUID } from 'node:crypto';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  field,
  getTestDatabase,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  TenantScoped,
  tenantId,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeReport } from '../runtime-report.js';
import {
  archiveRuntimeReportForPrincipal,
  createRuntimeReportConfirmHandler,
  loadRuntimeReportChart,
  runRuntimeReportForPrincipal,
} from '../runtime-server.js';
import {
  parseRuntimeReportSpec,
  runtimeReportSpecHash,
} from '../runtime-spec.js';

@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'runtime_server_test_sales' })
class RuntimeServerTestSale extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'integer', format: 'money' }) amount = 0;
  @field({ type: 'integer', readPermission: 'finance.margin' }) margin = 0;
  @field({ type: 'text' }) category = '';
}
void RuntimeServerTestSale;

const sources = [
  {
    id: 'sales',
    className: 'RuntimeServerTestSale',
    collection: 'runtime_server_test_sales',
  },
];
const spec = parseRuntimeReportSpec({
  title: 'Revenue',
  source: 'sales',
  dimensions: [{ field: 'category' }],
  measures: [{ fn: 'sum', field: 'amount', as: 'revenue' }],
});
function request(value = spec): Request {
  return new Request('https://app.test/api/_reports/runtime/confirm', {
    method: 'POST',
    headers: { origin: 'https://app.test', 'content-type': 'application/json' },
    body: JSON.stringify({
      spec: value,
      specHash: runtimeReportSpecHash(value),
    }),
  });
}

afterEach(() => {
  disableTenancy();
  clearCache();
  vi.restoreAllMocks();
});

for (const type of ['sqlite', 'duckdb', 'postgres'] as const) {
  const pgUrl = process.env.SMRT_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
  describe.skipIf(type === 'postgres' && !pgUrl)(
    `runtime report server on ${type}`,
    () => {
      it('confirms atomically, retries, scopes viewers, maps chart minor units and archives', async () => {
        const db = await getTestDatabase({
          type,
          url: type === 'postgres' ? pgUrl : ':memory:',
          classes: ['RuntimeReport', 'RuntimeServerTestSale'],
        });
        const tenant = randomUUID();
        const otherTenant = randomUUID();
        const userId = randomUUID();
        const principal = {
          db,
          userId,
          tenantId: tenant,
          permissions: [
            'runtimereports.create',
            'runtimereports.read',
            'runtime_server_test_sales.read',
            'finance.margin',
          ],
        };
        enableTenancy();
        setConfig({ packages: { reports: { runtime: { sources } } } });
        try {
          for (const [tenantId, amount, category] of [
            [tenant, 12345, 'Service'],
            [otherTenant, 99999, 'Private'],
          ] as const) {
            await withTenant({ tenantId }, async () => {
              const sale = new RuntimeServerTestSale({
                db,
                tenantId,
                amount,
                margin: 3000,
                category,
              });
              await sale.initialize();
              await sale.save();
            });
          }
          const handle = createRuntimeReportConfirmHandler({ sources });
          // A failure after claiming must roll back the claim and definition.
          const save = vi
            .spyOn(RuntimeReport.prototype, 'save')
            .mockRejectedValueOnce(new Error('injected write failure'));
          expect((await handle(request(), principal)).status).toBe(500);
          save.mockRestore();
          const responses = await Promise.all([
            handle(request(), principal),
            handle(request(), principal),
          ]);
          expect(responses.map((response) => response.status).sort()).toEqual([
            200, 201,
          ]);
          const saved = await responses[0].json();
          expect(await responses[1].json()).toEqual(saved);
          const result = await runRuntimeReportForPrincipal(
            saved.id,
            { ...principal, userId: randomUUID() },
            { sources },
          );
          expect(result.rows).toEqual([
            { category: 'Service', revenue: 12345 },
          ]);
          expect(
            await loadRuntimeReportChart(
              { reportId: saved.id, measure: 'revenue' },
              { reportPrincipal: principal, currency: 'CAD' },
            ),
          ).toEqual({
            points: [{ label: 'Service', value: 12345 }],
            format: 'money',
            currency: 'CAD',
            href: `/reports/${saved.id}`,
          });
          await expect(
            loadRuntimeReportChart(
              { reportId: saved.id, measure: 'missing' },
              { reportPrincipal: principal },
            ),
          ).rejects.toMatchObject({ status: 422 });
          await expect(
            runRuntimeReportForPrincipal(
              saved.id,
              { ...principal, tenantId: otherTenant },
              { sources },
            ),
          ).rejects.toMatchObject({ status: 404 });
          const privateSpec = parseRuntimeReportSpec({
            ...spec,
            measures: [{ fn: 'sum', field: 'margin', as: 'margin' }],
          });
          const privateSaved = await (
            await handle(request(privateSpec), principal)
          ).json();
          expect(
            await loadRuntimeReportChart(
              { reportId: privateSaved.id, measure: 'margin' },
              { reportPrincipal: principal },
            ),
          ).toMatchObject({ format: 'integer' });
          await expect(
            runRuntimeReportForPrincipal(
              privateSaved.id,
              {
                ...principal,
                permissions: principal.permissions.filter(
                  (permission) => permission !== 'finance.margin',
                ),
              },
              { sources },
            ),
          ).rejects.toMatchObject({ status: 403 });
          expect(
            await archiveRuntimeReportForPrincipal(saved.id, true, principal),
          ).toEqual({ id: saved.id, status: 'archived' });
          await expect(
            runRuntimeReportForPrincipal(saved.id, principal, { sources }),
          ).rejects.toMatchObject({
            status: 409,
            code: 'report_archived',
          });
          const archivedRetries = await Promise.all([
            handle(request(), principal),
            handle(request(), principal),
          ]);
          expect(archivedRetries.map(({ status }) => status)).toEqual([
            409, 409,
          ]);
          for (const archivedRetry of archivedRetries) {
            expect(await archivedRetry.json()).toMatchObject({
              code: 'report_archived',
            });
          }
          expect(
            await archiveRuntimeReportForPrincipal(saved.id, false, principal),
          ).toEqual({ id: saved.id, status: 'active' });
          expect((await handle(request(), principal)).status).toBe(200);
          const rows = await db.query(
            'SELECT spec FROM runtime_reports WHERE tenant_id = $1',
            tenant,
          );
          expect(rows.rows).toHaveLength(2);
          expect(
            rows.rows.every((row) => !String(row.spec).includes('12345')),
          ).toBe(true);
        } finally {
          await db.query(
            'DELETE FROM runtime_reports WHERE tenant_id = $1',
            tenant,
          );
          await db.query(
            'DELETE FROM _smrt_run_once_claims WHERE tenant_id = $1',
            tenant,
          );
          await db.query(
            'DELETE FROM runtime_server_test_sales WHERE tenant_id IN ($1, $2)',
            tenant,
            otherTenant,
          );
          await db.close?.();
        }
      }, 60_000);
    },
  );
}

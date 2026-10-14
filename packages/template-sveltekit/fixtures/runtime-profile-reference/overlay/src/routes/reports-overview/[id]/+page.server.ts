import {
  loadRuntimeReportChart,
  RuntimeReportsRecipe,
} from '@happyvertical/smrt-reports';
import {
  createWidgetRegistry,
  loadOverview,
  registerRecipeWidgets,
  type OverviewDefinition,
} from '@happyvertical/smrt-svelte/overview/server';
import { error } from '@sveltejs/kit';
import { runtime } from '$lib/server/smrt';
import type { PageServerLoad } from './$types';

const definition = (reportId: string): OverviewDefinition => ({
  id: 'notes.home',
  allowed: ['runtime-report-chart'],
  defaults: [
    {
      id: 'note-count',
      type: 'runtime-report-chart',
      span: 2,
      options: { reportId, measure: 'notes' },
    },
  ],
});

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user?.id || !locals.tenantId) error(401, 'Sign in required');
  const registry = createWidgetRegistry();
  await registerRecipeWidgets(
    registry,
    [RuntimeReportsRecipe],
    (specifier, name) =>
      specifier === '@happyvertical/smrt-reports' &&
      name === 'loadRuntimeReportChart'
        ? loadRuntimeReportChart
        : undefined,
  );
  const reportCollection = await runtime.getCollection('RuntimeReport');
  const page = definition(params.id);
  const overview = await loadOverview(
    { widgets: [...page.defaults] },
    page,
    registry,
    {
      reportPrincipal: {
        db: reportCollection.db,
        userId: locals.user.id,
        tenantId: locals.tenantId,
        permissions: locals.permissions ?? [],
      },
    },
  );
  return {
    definition: page,
    overview,
    surfaces: RuntimeReportsRecipe.surfaces,
  };
};

import {
  parseRuntimeReportSpec,
  runtimeReportSpecHash,
  type RuntimeReportAwaitingConfirmation,
} from '@happyvertical/smrt-reports';
import { error } from '@sveltejs/kit';
import type { Note } from '$lib/objects/Note';
import { runtime } from '$lib/server/smrt';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user?.id || !locals.tenantId) error(401, 'Sign in required');
  const notes = await runtime.getCollection<Note>('Note');
  const rows = await notes.list({ limit: 100 });
  const spec = parseRuntimeReportSpec({
    title: 'Browser note count',
    source: 'notes',
    dimensions: [],
    measures: [{ fn: 'count', as: 'notes' }],
    chart: { type: 'stat', y: ['notes'] },
  });
  const specHash = runtimeReportSpecHash(spec);
  const proposal: RuntimeReportAwaitingConfirmation = {
    status: 'awaiting_confirmation',
    spec,
    specHash,
    sourceLabel: 'Notes',
    confirmPath: '/api/_reports/runtime/confirm',
    preview: {
      version: 1,
      specHash,
      title: spec.title,
      columns: [
        {
          id: 'notes',
          label: 'Notes',
          role: 'measure',
          type: 'integer',
        },
      ],
      rows: [{ notes: rows.length }],
      rowCount: 1,
      truncated: false,
      ranAt: new Date().toISOString(),
      chart: spec.chart,
    },
  };
  return { proposal };
};

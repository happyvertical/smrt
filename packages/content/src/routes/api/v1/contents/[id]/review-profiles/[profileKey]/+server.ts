import { json, type RequestHandler } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';

type ContentRouteLocals = {
  tenantId?: string | null;
};

async function loadContent(id: string, locals: ContentRouteLocals) {
  const contentsCollection = await getCollection<any>(
    '@happyvertical/smrt-content:Content',
  );
  const tenantId = locals.tenantId || '';
  const content = await contentsCollection.get({ id });

  if (!content) {
    return {
      error: json({ error: 'Content not found' }, { status: 404 }),
      content: null,
    };
  }

  if (content.tenantId && content.tenantId !== tenantId) {
    return {
      error: json({ error: 'Unauthorized' }, { status: 403 }),
      content: null,
    };
  }

  return { content, error: null };
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const smrtLocals = locals as ContentRouteLocals;
  const { id, profileKey } = params;

  if (!id || !profileKey) {
    return json(
      { error: 'Content ID and profileKey are required' },
      { status: 400 },
    );
  }

  try {
    const loaded = await loadContent(id, smrtLocals);
    if (loaded.error || !loaded.content) {
      return loaded.error as Response;
    }

    const evaluation = await loaded.content.evaluateReviewProfile(profileKey);
    return json({ data: evaluation });
  } catch (err: any) {
    console.error(
      `Error evaluating review profile ${profileKey} for content ${id}:`,
      err,
    );
    return json(
      { error: err.message || 'Failed to evaluate content review profile' },
      { status: 500 },
    );
  }
};

/**
 * Home page server load + demo mutation.
 *
 * This file is the reference data-loading pattern for SMRT + SvelteKit apps:
 *
 *   1. **Query collections in a server `load`** — not with a client-side
 *      `fetch` on mount. SvelteKit runs this during SSR, serializes the
 *      returned data into the initial HTML, and hydrates it on the client
 *      without re-fetching. The page renders with its data on first paint;
 *      there is no empty-then-fetch waterfall and no duplicate first-render
 *      request. Server loads read the database directly through the
 *      collection API — they do not round-trip through your own
 *      `/api/*` routes.
 *
 *   2. **Declare one dependency key per collection** with
 *      `depends('smrt:<collection>')`, where `<collection>` matches the
 *      generated REST route segment (`/api/items` → `smrt:items`). After a
 *      mutation, client code calls `invalidate('smrt:<collection>')`
 *      (see `+page.svelte`) and every load that declared the key re-runs.
 *
 *   3. **Opt read-heavy SSR reads into the collection read cache** with
 *      `cache: { ttl }`. Mutations that go through SMRT (`create()`,
 *      `save()`, `delete()`) invalidate the table's cache entries
 *      in-process automatically, so the post-mutation `invalidate()`
 *      re-runs this load against fresh rows. See "Data loading" in the
 *      README for multi-replica caveats and when NOT to cache.
 */

import { fail } from '@sveltejs/kit';
import type { Item } from '$lib/objects/Item';
import { getCollection } from '$lib/server/smrt';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
  // Convention: `smrt:<collection>`. Registered before the query so even a
  // failed load (e.g. database not initialized yet) re-runs on invalidation.
  depends('smrt:items');

  try {
    const items = await getCollection<Item>('Item');
    const rows = await items.list({
      orderBy: 'created_at DESC',
      limit: 50,
      // Opt this SSR read into the collection read cache (issue #1499).
      // Safe here because all writes go through SMRT, which invalidates the
      // table's entries in this process. Running multiple replicas? Add
      // `crossProcess: true` or drop the cache — see the README.
      cache: { ttl: 30_000 },
    });

    return {
      // Return plain serializable objects: SvelteKit encodes load data into
      // the initial HTML with devalue, so pick the fields the page needs
      // rather than returning class instances. Persisted rows always carry a
      // UUID `id`; the filter narrows the field's `string | null | undefined`
      // type instead of coercing — a '' fallback would produce colliding
      // `{#each}` keys if an id were ever missing.
      items: rows
        .filter((item): item is Item & { id: string } => Boolean(item.id))
        .map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
        })),
      loadError: null as string | null,
    };
  } catch (e) {
    // First run before `smrt db:setup` has created the tables: render the
    // page with guidance instead of a 500.
    return {
      items: [] as { id: string; title: string; status: string }[],
      loadError: e instanceof Error ? e.message : 'Failed to load items',
    };
  }
};

export const actions: Actions = {
  /**
   * Demo mutation for the invalidation convention: creates an Item, then the
   * client (`+page.svelte`) calls `invalidate('smrt:items')` so the load
   * above re-runs and the new row appears without a full page reload.
   *
   * NOTE: this demo action is intentionally unauthenticated so the refresh
   * flow works out of the box. Real mutations should be gated on
   * `locals.user` / permissions (the generated `/api/*` routes are already
   * fail-closed: they 401 unless authenticated or `@smrt({ api: { public } })`).
   */
  create: async ({ request }) => {
    const form = await request.formData();
    const title = String(form.get('title') ?? '').trim();

    if (!title) {
      return fail(400, { title, error: 'Title is required' });
    }

    try {
      const items = await getCollection<Item>('Item');
      await items.create({ title });
      return { created: title };
    } catch (e) {
      return fail(500, {
        title,
        error: e instanceof Error ? e.message : 'Failed to create item',
      });
    }
  },
};

/**
 * The cookbook this checkout was built from (`smrt.cookbook.json`, written by
 * `smrt cookbook apply`) and the edits people make to it in the running app.
 *
 * The file is the app's default. Edits to section overviews and to the shell
 * layout are personal preferences: they are stored through smrt-preferences
 * (`_smrt_ui_preferences`, per tenant and user), never written back to the
 * file. `loadCookbook` lays the stored preferences over the file;
 * `saveCookbookEdits` turns the cookbook `CookbookApp` reports after an edit
 * back into the stored preference.
 */

import type { SmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
import { resolveDatabase } from '@happyvertical/smrt-core';
import {
  createOverviewStore,
  createPreferenceStore,
  createShellSettingsPreferences,
  PreferenceAccessError,
  type PreferenceScope,
} from '@happyvertical/smrt-preferences';
import type { CookbookAppProps } from '@happyvertical/smrt-svelte/cookbook';
import { createCookbookRegistry } from '@happyvertical/smrt-svelte/cookbook';
import {
  buildCookbookShell,
  type CookbookAppData,
  hasCookbook,
  type LoadCookbookAppOptions,
  loadCookbookApp,
} from '@happyvertical/smrt-svelte/cookbook/server';
import {
  diffOverview,
  type OverviewDefinition,
  type OverviewOverride,
  resolveOverview,
  type WidgetRegistry,
} from '@happyvertical/smrt-svelte/overview/server';
import type { Cookbook } from '@happyvertical/smrt-types';

/** The shell's preference surface id; the layout is stored once per person. */
export const SHELL_SURFACE = 'admin';

export type CookbookScope = PreferenceScope;

export type CookbookSaveResult =
  | { ok: true; saved: string[] }
  | { ok: false; reason: 'not_allowed' | 'conflict' | 'invalid'; id?: string };

type Shell = ReturnType<typeof buildCookbookShell>;

/** Where the cookbook lives; the project root and `smrt.cookbook.json` by default. */
export type CookbookSource = Pick<LoadCookbookAppOptions, 'root' | 'file'>;

/** Persist cookbook shell edits using the existing overview and shell preference kinds. */
export function createCookbookPreferences(options: {
  runtime: Pick<SmrtSvelteKitRuntime, 'databaseConfig'>;
  resolveExport?: CookbookAppProps['resolveExport'];
  app?: () => Promise<CookbookAppData>;
}) {
  const { runtime, resolveExport } = options;
  const liveApp = options.app;
  const loadApp = (source: CookbookSource) =>
    options.app && !source.root && !source.file
      ? options.app()
      : loadCookbookApp(source);
  async function prepare(app: CookbookAppData) {
    const shell = buildCookbookShell({
      cookbook: app.cookbook,
      catalog: app.catalog,
    });
    const { registry } = await createCookbookRegistry({
      widgets: shell.widgets,
      resolveExport,
    });
    return { shell, registry };
  }

  /** The page defaults with the cookbook file's own override already applied. */
  function fileDefinition(
    page: Shell['overviews'][string],
    registry: WidgetRegistry,
  ): OverviewDefinition {
    const { document } = resolveOverview(
      page.definition,
      page.override,
      registry,
    );
    return { ...page.definition, defaults: document.widgets };
  }

  async function stores() {
    const config = runtime.databaseConfig();
    if (!config) throw new Error('The runtime has no database configured.');
    const db = await resolveDatabase(config);
    const preferences = createPreferenceStore({ db });
    return {
      overviews: createOverviewStore({ db, preferences }),
      shell: createShellSettingsPreferences(preferences),
    };
  }

  /**
   * The project's cookbook with the signed-in person's stored preferences laid
   * over it, or `null` when the project has no cookbook. An invalid cookbook
   * throws (the message lists every problem).
   */
  async function loadCookbook(
    options: { signedIn: boolean } & CookbookSource,
  ): Promise<CookbookAppData | null> {
    if (
      (!liveApp || options.root || options.file) &&
      !(await hasCookbook(options.root, options.file))
    )
      return null;
    const app = await loadApp(options);
    if (!options.signedIn) return app;
    try {
      const { shell, registry } = await prepare(app);
      const { overviews, shell: layouts } = await stores();
      const cookbook: Cookbook = { ...app.cookbook };

      const stored: Record<string, OverviewOverride> = {};
      for (const [id, page] of Object.entries(shell.overviews)) {
        const state = await overviews.load(
          fileDefinition(page, registry),
          registry,
        );
        const base = resolveOverview(page.definition, null, registry).document;
        const override = diffOverview(base, state.document);
        if (override) stored[id] = override;
      }
      if (Object.keys(stored).length > 0) cookbook.overviews = stored;
      else delete cookbook.overviews;

      const { delta } = await layouts.read(SHELL_SURFACE);
      if (delta.layout) cookbook.layout = delta.layout as Cookbook['layout'];
      return { ...app, cookbook };
    } catch (error) {
      // A person without preference permissions still gets the file's cookbook.
      if (error instanceof PreferenceAccessError) return app;
      throw error;
    }
  }

  function sameJson(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Store the layout and overview edits in `edited`, the cookbook `CookbookApp`
   * reports (untrusted: only its `layout` and `overviews` are read, and each is
   * validated by the preference kind before anything is stored). `scope: 'user'`
   * keeps a personal version; `'tenant'` changes the default everyone starts
   * from and needs `overviews.customize` / `shell.customize`.
   */
  async function saveCookbookEdits(
    edited: unknown,
    scope: CookbookScope = 'user',
    source: CookbookSource = {},
  ): Promise<CookbookSaveResult> {
    const app = await loadApp(source);
    const { shell, registry } = await prepare(app);
    const { overviews, shell: layouts } = await stores();
    const input = isRecord(edited) ? edited : {};
    const wanted = isRecord(input.overviews) ? input.overviews : {};
    const saved: string[] = [];

    for (const [id, page] of Object.entries(shell.overviews)) {
      const definition = fileDefinition(page, registry);
      const state = await overviews.load(definition, registry);
      const desired = resolveOverview(
        page.definition,
        wanted[id] ?? null,
        registry,
      ).document;
      if (sameJson(desired, state.document)) continue;
      // Each tier stores a delta against the tier below it.
      const below =
        scope === 'tenant' ? state.tenant.base : state.tenant.document;
      const result = await overviews.save(definition, registry, {
        scope,
        override: diffOverview(below, desired),
        revision:
          scope === 'tenant'
            ? state.tenant.revision
            : (state.user?.revision ?? null),
      });
      if (!result.ok) return { ok: false, reason: result.reason, id };
      saved.push(id);
    }

    const current = (await layouts.read(SHELL_SURFACE)).delta.layout;
    const desiredLayout = isRecord(input.layout)
      ? input.layout
      : (app.cookbook.layout ?? null);
    if (!sameJson(desiredLayout, current ?? app.cookbook.layout)) {
      const result = sameJson(desiredLayout, app.cookbook.layout)
        ? await layouts.reset(SHELL_SURFACE, { scope })
        : await layouts.write(
            SHELL_SURFACE,
            { layout: desiredLayout },
            { scope },
          );
      if (!result.ok) return { ok: false, reason: result.reason, id: 'layout' };
      saved.push('layout');
    }
    return { ok: true, saved };
  }

  /** The cookbook's first section page, respecting the owner's section order. */
  function homePath(app: CookbookAppData): string {
    const shell = buildCookbookShell({
      cookbook: app.cookbook,
      catalog: app.catalog,
    });
    // The layout's own order may name custom sections, which are not suggestions.
    const first =
      app.cookbook.layout?.sectionOrder?.[0] ?? shell.sections[0]?.id;
    return first
      ? shell.sectionPath(first).replace(/(.)\/$/, '$1')
      : '/settings';
  }

  return { loadCookbook, saveCookbookEdits, homePath };
}

/**
 * A navigation list (a menu, a tab row, a section list) as a mounted data
 * surface, so an agent can move a person between pages without a REST path.
 *
 * A view intent can only dispatch a registry command, so "go to page X" needs
 * a mounted surface whose visible control performs the navigation. This
 * registers one: the links are published in the snapshot state
 * (`state.links`: id, label, description, group — never an href an agent
 * could steer), and each declared control resolves its payload to one of
 * those links (or to a caller-built href) and hands it to `navigate`.
 *
 * Navigation is a read-only view-state change: nothing is created or changed.
 */

import type {
  DataSurfaceDescriptor,
  DataSurfaceJsonValue,
  DataSurfaceKind,
  DataSurfaceRegistry,
  DataSurfaceSubject,
  DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-types';
import { trackSurfaceNavigation } from './surface-navigation.js';

export interface LinkSurfaceItem {
  /** Stable id, e.g. the nav item or tab id. */
  id: string;
  /** Plain label a person sees in the menu. */
  label: string;
  href: string;
  description?: string;
  /** Group or section heading the link sits under, if any. */
  group?: string;
}

export interface LinkSurfaceControl {
  id: string;
  label: string;
  description?: string;
  /**
   * Resolve a command payload to an href, or `null` to refuse. Defaults to
   * {@link resolveLinkTarget} over the published links.
   */
  resolve?: (
    payload: DataSurfaceJsonValue | undefined,
    links: readonly LinkSurfaceItem[],
  ) => string | null;
}

export interface LinkSurfaceOptions {
  registry: DataSurfaceRegistry;
  surfaceId: string;
  kind?: DataSurfaceKind;
  subject?: DataSurfaceSubject;
  label: string;
  description: string;
  links: readonly LinkSurfaceItem[];
  /** Defaults to one `open` control over the published links. */
  controls?: readonly LinkSurfaceControl[];
  /**
   * Perform the navigation. Return its promise (e.g. SvelteKit's `goto`):
   * the command does not wait for it, since the new page may unmount this
   * surface, but it is tracked on the registry, so
   * `whenSurfaceNavigationSettled(registry)` resolves only once it finished
   * and the new page's surfaces registered.
   */
  navigate: (href: string) => unknown;
  /** Extra JSON state published alongside the links (e.g. the active id). */
  state?: Record<string, DataSurfaceJsonValue>;
}

export interface LinkSurfaceHandle {
  update(next: {
    links?: readonly LinkSurfaceItem[];
    state?: Record<string, DataSurfaceJsonValue>;
  }): void;
  destroy(): void;
}

/** Cap on published links (and the surface's query limit). */
export const LINK_SURFACE_MAX_LINKS = 200;

const DEFAULT_CONTROLS: readonly LinkSurfaceControl[] = [
  {
    id: 'open',
    label: 'Open',
    description:
      'Go to one of the listed pages. Payload: { target } — a link id or its label.',
  },
];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The string an agent passed: `"Events"` or `{ target: "Events" }` (also
 * `id` / `label` / `section` / `tab` / `page`).
 */
export function linkTargetFromPayload(
  payload: DataSurfaceJsonValue | undefined,
): string | null {
  if (typeof payload === 'string') return payload.trim() ? payload : null;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const key of ['target', 'id', 'label', 'section', 'tab', 'page']) {
      const value = (payload as Record<string, DataSurfaceJsonValue>)[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return null;
}

/**
 * Resolve a payload to one link's href: by id, then exact label, then a unique
 * label prefix, all case-insensitive. Ambiguity resolves to `null`.
 */
export function resolveLinkTarget(
  payload: DataSurfaceJsonValue | undefined,
  links: readonly LinkSurfaceItem[],
): string | null {
  const target = linkTargetFromPayload(payload);
  if (!target) return null;
  const wanted = normalize(target);
  const byId = links.find((link) => normalize(link.id) === wanted);
  if (byId) return byId.href;
  const byLabel = links.filter((link) => normalize(link.label) === wanted);
  if (byLabel.length === 1) return byLabel[0].href;
  if (byLabel.length > 1) return null;
  const byPrefix = links.filter((link) =>
    normalize(link.label).startsWith(wanted),
  );
  return byPrefix.length === 1 ? byPrefix[0].href : null;
}

function publishedLinks(
  links: readonly LinkSurfaceItem[],
): DataSurfaceJsonValue {
  return links.slice(0, LINK_SURFACE_MAX_LINKS).map((link) => ({
    id: link.id,
    label: link.label,
    ...(link.description ? { description: link.description } : {}),
    ...(link.group ? { group: link.group } : {}),
  }));
}

/** The descriptor {@link registerLinkSurface} mounts. */
export function linkSurfaceDescriptor(
  options: Pick<
    LinkSurfaceOptions,
    'surfaceId' | 'kind' | 'subject' | 'label' | 'description' | 'controls'
  >,
): DataSurfaceDescriptor {
  const columns: DataSurfaceDescriptor['columns'] = [
    { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
    { id: 'label', label: 'Name', capabilities: ['read'] },
    { id: 'description', label: 'About', capabilities: ['read'] },
    { id: 'group', label: 'Group', capabilities: ['read'] },
  ];
  return {
    version: 1,
    identity: {
      kind: options.kind ?? 'list',
      surfaceId: options.surfaceId,
      ...(options.subject ? { subject: options.subject } : {}),
    },
    schemaVersion: 1,
    label: options.label,
    description: options.description,
    rowKey: 'id',
    columns,
    query: {
      modes: ['rows'],
      projectableColumnIds: columns.map((column) => column.id),
      filterableColumnIds: [],
      sortableColumnIds: [],
    },
    controls: (options.controls ?? DEFAULT_CONTROLS).map((control) => ({
      id: control.id,
      label: control.label,
      ...(control.description ? { description: control.description } : {}),
    })),
    actions: [],
    limits: {
      maxQueryRows: LINK_SURFACE_MAX_LINKS,
      maxQueryBytes: 200_000,
      maxSelectionSize: 1,
    },
  };
}

/** Mount a navigation list on a data-surface registry. */
export function registerLinkSurface(
  options: LinkSurfaceOptions,
): LinkSurfaceHandle {
  let links = [...options.links];
  let extraState = { ...(options.state ?? {}) };
  let revision = 1;
  const controls = new Map(
    (options.controls ?? DEFAULT_CONTROLS).map((control) => [
      control.id,
      control,
    ]),
  );

  const dispose = options.registry.register({
    descriptor: linkSurfaceDescriptor(options),
    getSnapshot: () => ({
      revision,
      state: { ...extraState, links: publishedLinks(links) },
      selection: null,
    }),
    execute: (command: DataSurfaceVisibleCommand) => {
      const control = controls.get(command.controlId);
      if (!control) return { ok: false };
      const href = (control.resolve ?? resolveLinkTarget)(
        command.payload,
        links,
      );
      if (!href) return { ok: false };
      void trackSurfaceNavigation(options.registry, options.navigate(href));
      return undefined;
    },
  });

  return {
    update(next) {
      const nextLinks = next.links ? [...next.links] : links;
      const nextState = next.state ? { ...next.state } : extraState;
      const changed =
        JSON.stringify(publishedLinks(nextLinks)) !==
          JSON.stringify(publishedLinks(links)) ||
        JSON.stringify(nextState) !== JSON.stringify(extraState) ||
        nextLinks.length !== links.length ||
        nextLinks.some((link, index) => link.href !== links[index]?.href);
      links = nextLinks;
      extraState = nextState;
      if (changed) revision += 1;
    },
    destroy() {
      dispose();
    },
  };
}

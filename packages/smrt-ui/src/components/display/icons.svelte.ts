/** Application icon paths, using the Icon component's configured viewBox. */
export type IconPathMap = Readonly<Record<string, string>>;

// Common M3 Icon Paths (Simplified)
const presets = new Map(
  Object.entries({
    menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
    search:
      'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    close:
      'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z',
    'chevron-right': 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6-6-6z',
    'chevron-left': 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59z',
    'chevron-down': 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    mic: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.04 6.43 5 7.07V21h4v-2.93c2.96-.64 5-3.54 5-7.07h-2z',
    alert: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v6h-2zm0 8h2v2h-2z',
    warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2zm0-4h-2v-4h2z',
    info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z',
    home: 'M3 10 12 2 21 10v11h-6v-7H9v7H3z',
    user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21v-2c0-4 16-4 16 0v2H4z',
    settings:
      'M10 2h4l1 3 3-1 3 3-1 3 3 1v4l-3 1 1 3-3 3-3-1-1 3h-4l-1-3-3 1-3-3 1-3-3-1v-4l3-1-1-3 3-3 3 1 1-3zm2 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    trash:
      'M7 3h10v2h4v2H3V5h4V3zm-2 6h14v12H5V9zm4 2v8h2v-8H9zm4 0v8h2v-8h-2z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    calendar: 'M7 2h2v2h6V2h2v2h4v18H3V4h4V2zm-2 8v10h14V10H5zm2 2h4v4H7v-4z',
    clock:
      'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 2h2v5.5l4 2.5-1 1.5-5-3V6z',
    camera:
      'M9 3h6l2 3h4v15H3V6h4l2-3zm3 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
    upload:
      'M11 16V7l-4 4-1.5-1.5L12 3l6.5 6.5L17 11l-4-4v9h-2zM3 18h18v3H3v-3z',
    download: 'M11 3h2v9l4-4 1.5 1.5L12 16l-6.5-6.5L7 8l4 4V3zM3 18h18v3H3v-3z',
  }),
);

interface Registration {
  paths: ReadonlyMap<string, string>;
}
let registrations = $state.raw<Registration[]>([]);

/**
 * Register an application icon set, returning an idempotent cleanup function.
 * Last active registration wins; caller-owned maps are snapshotted. Register
 * static application sets at startup, not request-specific or identity data.
 */
export function registerIcons(icons: IconPathMap): () => void {
  if (!icons || typeof icons !== 'object' || Array.isArray(icons)) {
    throw new TypeError('Icon set must be a map of names to SVG path strings');
  }
  const entries = Object.entries(icons);
  for (const [name, path] of entries) {
    if (!name.trim() || typeof path !== 'string' || !path.trim()) {
      throw new TypeError('Icon names and paths must be nonempty strings');
    }
  }
  const registration: Registration = { paths: new Map(entries) };
  registrations = [...registrations, registration];
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    registrations = registrations.filter((entry) => entry !== registration);
  };
}

/** Resolve the last active application path, falling back to the builtin set. */
export function resolveIconPath(name: string): string | undefined {
  for (let index = registrations.length - 1; index >= 0; index--) {
    const path = registrations[index].paths.get(name);
    if (path !== undefined) return path;
  }
  return presets.get(name);
}

// The side menu, built from the definition.
import type { Description } from './types.ts';

export interface MenuItem {
  id: string;
  href: string;
  label: string;
  icon: string;
  description?: string;
  children?: MenuItem[];
}

/** An item of the user menu (Approvals, History), caller-owned destinations. */
export interface UserMenuItem {
  id: string;
  href: string;
  label: string;
  badge: number | null;
  badgeLabel?: string;
}

export function modelHref(model: string): string {
  return `/m/${encodeURIComponent(model)}`;
}

/** The side menu: Home and what the app (the assistant) has built. */
export function buildMenu(
  description: Pick<Description, 'models' | 'reports'> | null,
): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'home', href: '/', label: 'Home', icon: 'home' },
  ];
  for (const [name, model] of Object.entries(description?.models ?? {}))
    items.push({
      id: `model:${name}`,
      href: modelHref(name),
      label: model.label || name,
      icon: 'book',
    });
  const reports = Object.entries(description?.reports ?? {});
  if (reports.length)
    items.push({
      id: 'reports',
      href: '/reports',
      label: 'Reports',
      icon: 'chart',
      children: reports.map(([name, report]) => ({
        id: `report:${name}`,
        href: `/reports/${encodeURIComponent(name)}`,
        label: report.label ?? report.spec.title,
        icon: 'chart',
      })),
    });
  return items;
}

/**
 * The user menu's destinations, in order: Approvals (badged with the number
 * waiting, nothing when none) and History. They are not side menu entries.
 */
export function userMenuItems(pending = 0): UserMenuItem[] {
  const waiting = pending > 0 ? Math.floor(pending) : 0;
  return [
    {
      id: 'approvals',
      href: '/approvals',
      label: 'Approvals',
      badge: waiting || null,
      ...(waiting
        ? { badgeLabel: `${waiting} waiting for your decision` }
        : {}),
    },
    { id: 'history', href: '/history', label: 'History', badge: null },
  ];
}

// The side menu, built from the definition.
import type { Description } from './types.ts';

export interface MenuItem {
  id: string;
  href: string;
  label: string;
  icon: string;
  description?: string;
  badge?: number | null;
  attention?: boolean;
}

export function modelHref(model: string): string {
  return `/m/${encodeURIComponent(model)}`;
}

export function buildMenu(
  description: Pick<Description, 'models'> | null,
  pending = 0,
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
  items.push({
    id: 'approvals',
    href: '/approvals',
    label: 'Approvals',
    icon: 'done',
    description: 'Changes waiting for your decision',
    badge: pending > 0 ? pending : null,
    attention: pending > 0,
  });
  items.push({
    id: 'history',
    href: '/history',
    label: 'History',
    icon: 'undo',
  });
  return items;
}

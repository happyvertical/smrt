/**
 * Generic component types migrated from @happyvertical/svelte
 */
import type { Snippet } from 'svelte';
import type { HTMLAttributes, HTMLButtonAttributes } from 'svelte/elements';

// Badge types
export type BadgeVariant =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'class'> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children?: Snippet;
}

// Button types
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<HTMLButtonAttributes, 'class'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
  children?: Snippet;
}

// Card types
export type CardVariant = 'default' | 'outlined' | 'elevated';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  variant?: CardVariant;
  padding?: CardPadding;
  hoverable?: boolean;
  children?: Snippet;
  header?: Snippet;
  footer?: Snippet;
}

// Gap primitive types (L3 #1422)
export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';
export type AvatarStatus = 'online' | 'offline' | 'away' | 'busy';
export type ChipSize = 'sm' | 'md';
export type SkeletonVariant = 'text' | 'circle' | 'rect';
export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export type DropdownPlacement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end';

/** An item in a `Dropdown`/`Menu`. */
export interface MenuItem {
  /** Stable id, returned by `onselect`. */
  id: string;
  /** Visible item label. */
  label: string;
  /** Disable this item. */
  disabled?: boolean;
  /** Per-item activation handler. */
  onselect?: () => void;
}

/** A node in a `Tree`. */
export interface TreeNode {
  /** Stable id, returned by `onselect`. */
  id: string;
  /** Visible node label. */
  label: string;
  /** Child nodes; presence makes the node expandable. */
  children?: TreeNode[];
}

// Calendar types
export interface DayEventDetail {
  type: string;
  name: string;
  slug: string;
  startTime: string;
  venue?: string;
  councilSlug?: string;
}

export interface DayEventsData {
  date: string;
  events: DayEventDetail[];
}

export interface DayForecast {
  icon: string;
  high: number;
  low: number;
}

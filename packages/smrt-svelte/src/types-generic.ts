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

export interface DayEventDetail {
  type: 'game' | 'meeting' | 'event' | (string & {});
  name: string;
  startTime: string;
  venue?: string;
  slug?: string;
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

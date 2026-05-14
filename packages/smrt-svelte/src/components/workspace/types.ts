/**
 * Shared types for the workspace shell primitives.
 *
 * See @happyvertical/smrt#1226 (epic) and #1227 / #1228 / #1229 (implementers).
 */

import type { Component } from 'svelte';

// ────────────────────────────────────────────────
// Nav primitives (used by NavTree, Breadcrumbs)
// ────────────────────────────────────────────────

export interface NavItem {
  href: string;
  label: string;
  icon?: string;
  description?: string;
  exact?: boolean;
  defaultExpanded?: boolean;
  badge?: number | string | null;
  children?: NavItem[];
}

export interface BreadcrumbItem {
  href?: string;
  label: string;
}

// ────────────────────────────────────────────────
// Tools dock primitives
// ────────────────────────────────────────────────

export interface ToolDef<TCtx = unknown> {
  id: string;
  label: string;
  icon?: string;
  component: Component<{ context: TCtx; dock: ToolsDockApi }>;
  badge?: number | string | null;
}

export interface AvailableTool {
  id: string;
  label?: string;
  badge?: number | string | null;
}

export interface ToolsDockContext<TData = Record<string, unknown>> {
  type: string;
  title?: string;
  url?: string;
  data?: TData;
  actions?: Record<string, (...args: any[]) => unknown>;
}

export interface ToolsDockApi {
  readonly activeTool: string | null;
  readonly isOpen: boolean;
  readonly availableTools: ReadonlyArray<AvailableTool>;
  open(id?: string): void;
  close(): void;
  toggle(id?: string): void;
  setContext(ctx: ToolsDockContext | null): void;
  emit<TPayload>(event: string, payload: TPayload): void;
  on<TPayload>(event: string, handler: (payload: TPayload) => void): () => void;
}

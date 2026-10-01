/**
 * How a shell (an app's workspace layout) takes part in every `PageHeader`
 * below it, without the pages or the packages that render them knowing the
 * shell: it turns a page's own `parents` into the full ancestor trail (from
 * its nav) and hears each page's title, e.g. for a phone top bar.
 */
import { getContext, setContext } from 'svelte';

/** One ancestor of a page. */
export interface PageHeaderCrumb {
  label: string;
  href: string;
}

/** What a page reports to its shell. */
export interface PageHeaderReport {
  title: string;
  parents: readonly PageHeaderCrumb[];
}

export interface PageHeaderContext {
  /**
   * The page's ancestors (never the page itself), given the ancestors it
   * knows beyond the shell's nav. Called inside a reactive derivation, so
   * the shell may read reactive state (the current path, its nav).
   */
  crumbs(parents: readonly PageHeaderCrumb[]): PageHeaderCrumb[];
  /** Hear the page's title and parents; return a cleanup for when it goes. */
  report?(page: PageHeaderReport): (() => void) | undefined;
}

const PAGE_HEADER_CONTEXT = Symbol.for('smrt-ui.page-header');

/** Called by a shell layout; applies to every `PageHeader` below it. */
export function setPageHeaderContext(context: PageHeaderContext): void {
  setContext(PAGE_HEADER_CONTEXT, context);
}

/** The enclosing shell's page-header context, or null. */
export function getPageHeaderContext(): PageHeaderContext | null {
  return getContext<PageHeaderContext | undefined>(PAGE_HEADER_CONTEXT) ?? null;
}

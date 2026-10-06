/**
 * AdminShell's page-header contracts on phones. jsdom doesn't apply the
 * component's scoped styles, so these read the rules themselves: the phone
 * top bar replaces the page's crumbs and title, and tabs inside a page header
 * keep sticking under the bar.
 */
import { describe, expect, it } from 'vitest';
import source from '../admin-shell/AdminShell.svelte?raw';

const css = source.slice(source.indexOf('<style>'));

function rule(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `missing rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('AdminShell page-header contracts', () => {
  it('hides the breadcrumb row only with replacement phone navigation', () => {
    expect(
      rule(
        '.smrt-admin-shell[data-phone-top]:has(\n    > .smrt-admin-shell__phone-top :global([data-shell-page-navigation-replacement])\n  ) :global([data-shell-breadcrumbs])',
      ),
    ).toContain('display: none');
  });

  it('visually hides the page title while the phone top bar shows it', () => {
    const titleRule = rule(
      '.smrt-admin-shell[data-phone-top]:has(\n    > .smrt-admin-shell__phone-top :global([data-shell-page-title-replacement])\n  ) :global([data-shell-page-title])',
    );
    // Visually hidden, not display:none: screen readers and the document
    // outline keep the heading.
    expect(titleRule).toContain('position: absolute');
    expect(titleRule).toContain('clip-path: inset(50%)');
    expect(titleRule).not.toContain('display: none');
  });

  it("lets a page header's tabs stick under the top bar", () => {
    expect(
      rule(
        '.smrt-admin-shell[data-phone-top]\n    :global([data-page-header-extra]:has([data-shell-tabs]))',
      ),
    ).toContain('display: contents');
  });
});

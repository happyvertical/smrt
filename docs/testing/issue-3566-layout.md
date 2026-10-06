# Default page containment and phone headings (#3566)

Standard-risk visual-only patch. No data mutation, auth, external service, or
SQL behavior changes; executor/transaction and dialect coverage are N/A.
Supported runtime: Svelte 5 in Chromium; desktop, tablet, and phone widths.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PageLayout constrains intrinsic table/tab widths | Raw section directly inside PageLayout, wide table and tabs | Page fits 320/390/768; inner scrolling reaches last column/tab | Base expands the document; no clipping of last controls | Any consumer | Nested raw semantic section needs no CSS | Real browser | smrt-ui Playwright page-layout spec |
| Custom phone action bar preserves page title | AdminShell phoneTopBar contains an action only | Visible h1 and clickable action | Base hides h1 without replacement | Any phone user | Arbitrary snippet, no marker | Real browser | smrt-svelte Playwright phone-heading spec |
| Actual phone title avoids duplicate visible title | PhoneTopBar detail model | Heading remains accessible, bar title visible | Section/workspace title must not hide distinct page title; desktop retains h1 | Any shell user | Custom snippets explicitly mark replacement title | Real browser | smrt-svelte Playwright phone-heading spec |

Application composition should place PageHeader and Cards directly under
PageLayout when relying on its vertical gap. Semantic attributes can be passed
to PageLayout rather than adding an otherwise unstyled section wrapper.

Validation (Node 26.10.0, pnpm 11.25.0, installed Chromium):

- `pnpm --filter @happyvertical/smrt-ui test:e2e page-layout.spec.ts`: 3/3
  passed at 320/390/768. Same fixture on base 262a8a13c failed all three with
  document width 1819px; final tab and table column remain scroll-reachable.
- `pnpm --filter @happyvertical/smrt-svelte test:e2e phone-heading.spec.ts`:
  16/16 passed at 320/390/768/1024, covering action-only, workspace home,
  detail replacement, and custom replacement bars. Base action-only and home
  cases fail because h1 measures 1px; head keeps them visible.
- Focused shell Vitest: admin-shell-page-contracts, AdminShell.responsive,
  admin-shell-mobile: 51/51 passed. PageLayout Vitest: 11/11 passed.

Logs are retained under the local TradesChief ux-20261006 evidence directory
(layout-base/head, heading-base/head, layout-shell-unit, layout-ui-unit).
Full release validation and packed-consumer checks belong to the coordinator's
integration revision; these focused checks do not claim complete release gates.

Navigation follow-up: a title is not back navigation. AdminShell preserves
PageHeader breadcrumbs unless the phone bar explicitly declares
`data-shell-page-navigation-replacement`; PhoneTopBar's detail back link does.
The browser matrix now also checks visible/native ancestor links for action,
workspace-home and custom-title bars, and the replacement back link for detail
bars. All 16 scenarios pass; restoring only the old unconditional breadcrumb
rule makes the 320px action-bar scenario fail (hidden ancestor navigation).
This is the same presentation-only runtime/data scope as the heading rows.

Phone chrome surface follow-up: an action-only `phoneTopBar` must obscure the
content underneath when it returns after upward scrolling. AdminShell owns the
`--smrt-color-surface` background around arbitrary snippets, so hosts do not
need application CSS or a PhoneTopBar component merely to supply an action.
The maintained phone-heading browser fixture scrolls long content down and
back up in both light and dark modes, checks an opaque surface, and opens the
Assistant action. This preserves hide-on-scroll and snippet interaction.

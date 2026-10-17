# Runtime report browser surfaces (#3895)

The browser entry is `@happyvertical/smrt-reports/svelte`. It imports visual and
form primitives from smrt-ui, never smrt-svelte or the reports server barrel.
`@happyvertical/smrt-ui/charts` owns the five shared renderers; the overview
chart and report results both consume it.

- `SavedReports`: tenant-shared saved reports as a responsive grid of
  `SavedReportCard`s (title opening the report, a one-line description from
  `describeReport`, a headline figure and sparkline from a run, saved/updated
  time), Everyone's/Mine and Show archived filters (smrt-ui `SegmentedControl`,
  `Switch`), "New report", an empty state, and Archive in each card's "more"
  menu behind a confirmation. `variant: 'section'` is the Reports section page.
  The host resolves author ids (`authorLabel`), passes source labels
  (`sources`), and supplies an archive capability hint; the server authorizes
  every archive again. Each shown report runs once (three at a time).
- "New report" and Edit call smrt-ui `requestAssistant` (the dock fills its
  composer); with no assistant on the page the screen says where to ask.
- `ReportDetail`: a summary header (description, source, groupings, period
  with its dates, measures, filters, who saved it, last run), then the result
  run afresh on open and each re-run. Primary action by state: Edit, Try again
  after a failed run, Restore when archived; Export CSV (formatted,
  formula-safe) beside it; Re-run and Archive in the "more" menu. The transport is
  principal-scoped; replace it when viewer/tenant changes. Pending old
  responses are discarded, and result rows live only in component state.
- `ReportResult`: validates the result shape and safe integers. `full` (a
  report's page): a Chart/Table switch, a measure switch, headline figures
  (total for sums and counts, average per bucket, peak) and a tall smrt-ui
  `Chart` with a value axis and keyboard/pointer readout. `compact` (preview
  card): a quiet table toggle. Tables format money and time buckets. Money
  fields use integer minor units and the host's ISO currency (default USD).
- `saved-reports` widget (`SavedReportsWidget`, recipe `sectionDefault`): the
  Reports section page in any host rendering data widgets; it reads through
  the shared browser client unless the host passes `client`.
- `ReportConfirmation`: shows the source label, groupings, measures,
  filters, and a bounded preview. Approve requires a trusted local click and
  posts the exact displayed `{ spec, specHash }` to the proposal's same-origin
  `confirmPath` once while pending. Decline never calls the server. The server
  recompiles as the confirming principal and idempotently saves the approved
  spec; the hash carries no authority by itself.
- Answered state (#4100): after Approve or Decline the card shows an outcome
  line ("Report saved · Open report", "Declined — nothing saved") instead
  of buttons; pass `outcome` from the transcript so a reloaded card does too.
  `fields` (a source descriptor's names, labels, formats) labels groupings,
  buckets ("Issue date by month") and money filters; measures use the result's
  column labels. `ReportResult` labels time buckets by granularity
  (smrt-ui `formatTimeBucket`) and keeps the table toggle quiet.
- `ReportPicker`: labelled fields (smrt-ui `FormGroup`) offering readable
  active reports and their measures and groupings by name, not alias;
  changing the report clears dependent choices.

`createRuntimeReportsHttpClient()` implements the generated same-origin reads,
the enveloped `run`/`archive` actions, and the confirmation POST. It has no
database, tenant, or permission authority. Successful run timestamps live only
in that browser client's session map; route hosts include an opaque active
tenant/session scope so hints are discarded when the principal context changes. Omit the client (or set
`serverAvailable={false}` on a route component) for a static host: the screens
explain that reports need a server and make no requests.

`runtimeReportToolResultComponent` is the reports adapter for AssistantDock's
generic component seam. Recipe routes export `RuntimeReportsRoute` and
`RuntimeReportDetailRoute`; the `runtime-report-chart` surface exports its
renderer and dependent report/measure/dimension editor. The server host builds
the chart loader context from request-scoped `reportPrincipal`; widget options
never carry identity, permissions, tenant, or database authority.

The `./playground` entry has saved-list, detail, confirmation, picker, empty and
unavailable previews. They use deterministic sample data, not a production
backend. All component copy registers through `smrt-ui/i18n`.

The smrt planner (#4100) renders `ReportConfirmation`, `SavedReports` and
`ReportDetail` with its own `RuntimeReportsClient` over sample data and the
in-memory runner from `./spec`; its `confirm` is a browser save, not this
package's confirmation route.

The template reference application exercises the generic dock selector, a real
trusted browser approval click, authenticated confirmation and generated reads,
detail execution, and the recipe-registered overview loader/renderer without
mocking an endpoint.

# Runtime report browser surfaces (#3895)

The browser entry is `@happyvertical/smrt-reports/svelte`. It imports visual and
form primitives from smrt-ui, never smrt-svelte or the reports server barrel.
`@happyvertical/smrt-ui/charts` owns the five shared renderers; the overview
chart and report results both consume it.

- `SavedReports`: a tenant-shared list, Only mine and archived filters, author,
  source and optional last-run hint. The host resolves author ids and supplies
  an archive capability hint; the server authorizes every archive again.
- `ReportDetail`: gets a definition and runs it on open and each re-run. The
  transport is principal-scoped; replace it when viewer/tenant changes. Pending
  old responses are discarded, and result rows live only in component state.
- `ReportResult`: validates the result shape and safe integers, renders the
  chart hint and offers the complete table. Money fields use integer minor
  units and the host's ISO currency (default USD); locale defaults to `en`.
- `ReportConfirmation`: shows the source label, groupings, measures,
  filters, and a bounded preview. Approve requires a trusted local click and
  posts the exact displayed `{ spec, specHash }` to the proposal's same-origin
  `confirmPath` once while pending. Decline never calls the server. The server
  recompiles as the confirming principal and idempotently saves the approved
  spec; the hash carries no authority by itself.
- `ReportPicker`: offers readable active reports and their measures and
  dimensions; changing the report clears dependent choices.

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

The template reference application exercises the generic dock selector, a real
trusted browser approval click, authenticated confirmation and generated reads,
detail execution, and the recipe-registered overview loader/renderer without
mocking an endpoint.

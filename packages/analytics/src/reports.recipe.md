## Overview

Analytics keeps the traffic reports you care about for your websites and apps.
Add a property for each site or app you track in Google Analytics 4, Plausible
or Matomo. Save a report on it that says what to count, what to break the
figures down by, and over which dates. The rows each run returns are stored
with the report, and the assistant can read them back to you in plain words.

Properties and reports are kept on your server. Provider secrets are stored on
the property but never sent to the assistant or returned in responses.

## Tasks

### Add a property

1. Create a new property.
2. Enter the **{field:AnalyticsProperty.displayName}** and pick the
   **{field:AnalyticsProperty.provider}**.
3. Enter the **{field:AnalyticsProperty.externalId}** the analytics service
   gives it.
4. For Google Analytics, enter the **{field:AnalyticsProperty.measurementId}**.
   For Plausible or Matomo, enter the **{field:AnalyticsProperty.siteDomain}**.
5. Keep **{field:AnalyticsProperty.status}** on active while you want it
   tracked.

### Save a report

1. Create a new report and choose the property in
   **{field:AnalyticsReport.propertyId}**.
2. Give it a **{field:AnalyticsReport.name}**.
3. List what to break the figures down by in
   **{field:AnalyticsReport.dimensions}** and what to count in
   **{field:AnalyticsReport.metrics}**.
4. Set the period with **{field:AnalyticsReport.dateRangeStart}** and
   **{field:AnalyticsReport.dateRangeEnd}**.
5. Pick **{field:AnalyticsReport.frequency}** to repeat it daily, weekly or
   monthly.

### Check what a report found

1. **{field:AnalyticsReport.status}** says where the report stands, and
   **{field:AnalyticsReport.lastRunAt}** when it last ran.
2. **{field:AnalyticsReport.rowCount}** shows how many rows came back.
3. If a run failed, **{field:AnalyticsReport.lastError}** says why.

### Ask the assistant

1. Ask about a saved report by name, for example "how did last week's traffic
   report look?". When your app has the analytics tools switched on, the
   assistant can list your saved reports and open one to read its figures.
2. A written summary of a report comes from your app, which sends the stored
   rows to the AI provider as they are. Leave out dimensions that identify a
   person.
3. For totals your own app calculates, such as orders or signups, ask for a
   refreshed report. The assistant reads those with `reports.query`; see
   Reports.
4. For a one-off question those reports do not answer, the assistant can
   propose a report with `reports.runtime.define`. Nothing is saved until you
   confirm it.

## Overview

Reports keep totals and trends, such as revenue by month or signups by week,
worked out ahead of time so they open instantly. Someone on your team sets up
each report once. This feature then records when each report was last
refreshed, how that went, and when it runs next.

Reports are calculated on your server, never in the browser, so this feature
needs your app's database.

## Tasks

### Ask the assistant about a report

1. Ask in plain words, for example "what was revenue last month?".
2. The assistant looks up the reports your account may see
   (`data.discover`, `data.inspect`), then reads rows with `reports.query`.
   It only ever sees the columns and the customer data you are allowed to see.
3. If the numbers look old, ask how fresh the report is. The answer says when
   it was last refreshed.
4. Ask the assistant to refresh a stale report. It previews the refresh with
   `reports.refresh` and your app decides who may apply it.

The assistant offers these tools only when your app has switched them on.

### Ask a question no report covers

1. Describe what you want to see, for example "orders by status this quarter".
2. The assistant checks what it may report on (`reports.runtime.sources`) and
   shows a preview of the report it would save (`reports.runtime.define`).
3. Nothing is saved until you confirm that exact report.
4. Open it again later with `reports.runtime.list` and `reports.runtime.run`.

These reports are worked out live each time and their rows are never stored.
They are not refreshed in the background. A report that people open every day
is worth asking your team to set up as a refreshed report instead.

### Keep a report fresh

1. Ask your team how the report refreshes: by hand, on a schedule, after the
   data changes, or when it goes out of date.
2. A scheduled report repeats on its **{field:SmrtReportSchedule.cron}**, either
   rebuilding everything or updating only what changed, per its
   **{field:SmrtReportSchedule.mode}**.
3. Turn **{field:SmrtReportSchedule.enabled}** off to pause a schedule without
   losing it.
4. **{field:SmrtReportSchedule.nextRun}** shows when it is next due.

### Check that a refresh worked

1. Look at the latest run for the report. **{field:SmrtReportRun.status}**
   says whether it is running, finished, failed or skipped.
2. **{field:SmrtReportRun.completedAt}** and **{field:SmrtReportRun.rowCount}**
   show when it finished and how many rows it holds.
3. If it failed, **{field:SmrtReportRun.error}** says why.

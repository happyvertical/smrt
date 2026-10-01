---
'@happyvertical/smrt-agents': patch
---

`registerDataSurfaceBackgroundActionHandler` (and `createJobsDataSurfaceBackgroundQueue`) accept an optional `owner`. Re-registering a `handlerId` from the same owner, such as a host module re-evaluated by Vite hot reload, replaces the previous handler instead of throwing "Data-surface action handler already registered"; a different owner still throws. The handler registry now lives on `globalThis` so re-evaluated copies of this module share it.

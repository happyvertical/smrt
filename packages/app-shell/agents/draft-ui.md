# Draft UI validation

The content header owns draft controls. The saved owner view selects the
layout description; loaders and mutations carry that description's explicit
target. Changing copies remounts forms and returns home. Approvals always name
live. No report route is present. Shell copy uses the existing plain-text
pattern (the package has no message catalog).

| Behavior | Trigger and positive case | Failure case | Context / executor | Runtime / edge | Level / command |
|---|---|---|---|---|---|
| Content controls | Owner starts draft; count, switch, actions, chat badge | Unpublishable draft disables switching/review; discard remains | Owner browser, shell routes | Svelte 5 / draft events | DOM / package test |
| Explicit copy | Switch persists view; description drives reads and writes | Failed switch keeps rendered copy; other-copy record events ignored | Owner, server event.fetch and browser fetch | Node 26 + jsdom / REST and MCP targets | Node + DOM / package test |
| Draft records | Draft delete 200 navigates away | Live delete 202 waits for approval | Owner, existing server gate | SQLite through server (unchanged) | DOM / package test |
| Navigation | Draft-only model has new badge | Live lists only live models | Owner layout | jsdom / describe | DOM / package test |
| Review | Full preview, all code and archive counts | Chain change before request or approval offers review again | Owner gesture, pinned Approval | jsdom / preview + publish + decide | DOM / package test |
| History | Publish versions grouped, undo-to uses first parent | Purged/current boundaries disable undo; 202 links to approvals | Owner, existing undo transaction | Node 26 + jsdom / history | Node + DOM / package test |
| Lifecycle | Started/published/discarded/unpublishable refresh dependencies | Unknown events ignored; reconnect refreshes all | Owner SSE subscription | jsdom / EventSource | DOM + Node / package test |
| Live data survives | Define, fork, edit, write live, publish, undo, discard | Draft test rows excluded on publish | Owner HTTP session, real engine | Node 26 + SQLite / production server | Manual / README Run it |

Database/auth contracts and transactions are unchanged; their negative cases
remain covered by the existing server suites. This is a new UI, so a bug-fix
base comparison is not applicable. No containers or external services are needed.

Manual execution (Node 26.12.1, production adapter-node build, port 4821):
`smrt app setup` with a fresh real path under `/private/tmp`, then `node build`.
Created the owner through the setup form. Authenticated curl calls defined Chore,
seeded a live row, converted points and removed obsolete in the draft, added Note
and a code method, and added separate live/draft records after the fork. The
review UI showed full code and archive counts. Changing the chain after review
refused Publish and offered Review again. Publishing through its Approval kept
the new live row (points converted to 8), excluded the draft-only row, and tagged
all five versions. History's Undo this publish raised an Approval; approving
restored the text field and archived obsolete value and retained the live row.
Started another draft and confirmed Discard. At 390×844, the content controls
wrapped without horizontal overflow and retained the warning; the new marker
used the warning token. Stopped the server by PID and removed session cookies
and temporary runtime data. No browser page errors were observed.

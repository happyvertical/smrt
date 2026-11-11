# Desktop signed-out recovery

`createOwnerSetupPage` reuses the existing `OWNER_LINK_SECRET_ENV` launch marker
with the landed `launchMode: 'desktop'` projection. Missing, expired and claimed
links keep their existing link states. The shared `OwnerSetupForm` shows translated quit-and-reopen guidance
instead of terminal commands or an owner form. No environment value is returned.
An explicit, unclaimed invitation retains the original form contract for
`createOwnerLinkHandler` consumers whose `autoClaim` remains false. Deployed and
non-loopback requests still refuse setup without returning a token. Signed-in
visitors still redirect before setup.

This marker changes presentation only. The existing owner-link handler still
requires its per-launch secret, loopback peer and matching host. The wrapper
issues a fresh owner link each launch; the existing runtime creates or signs in
the sole owner, never a second owner. Explicit application failure messages keep
precedence over desktop defaults.

The runtime regression uses real SQLite to check pre-claim invitations, missing
links, claimed/spent links, remote refusal and authenticated redirects. Shared
component tests cover every recovery state with the desktop launch mode and
assert no form, token, terminal command or server failure text appears. A separate
ready-invitation test preserves the manual form. The packaged smoke
signs out, stops the process, then follows a fresh owner link and reaches the app
with the same data.

Reuse check: MCP `review_smrt_project` on runtime, smrt-svelte and desktop plus
`build_context` for desktop owner-link/signed-out recovery; intent index and `rg`
by name and purpose across smrt-ui, smrt-svelte, chat, core, app-runtime and
app-shell. Integration already owns the launch mode and shared reopen wording; E3 uses that
API and retains only its additional failure-message and relaunch regressions.
This documentation file adds no helper, component, model or route.

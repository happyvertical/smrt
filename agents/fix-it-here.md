## Fix it here; do not work around it, do not file it away

When something in this repository is broken — a pin, a hook, a gate, a stale
generated file, a rule a package quietly disagrees with — **fix it in the branch
you are already on**, as its own commit under `Drive-by fixes`. A workaround is
never the answer, and a reflex issue usually is not either.

- **No workarounds.** A shim, a skipped hook, a disabled gate, a `--no-verify`,
  a pinned-around version, an "unrelated environment artifact" — every one of
  these hides the defect and silently changes what your validation evidence
  means. If a documented validation command cannot run as documented, that is
  the bug; repair it or stop and report a blocker. Do not proceed on a
  substitute toolchain and then call the result green.
- **A drive-by inside the kernel's envelope is mandatory, not optional.** The
  kernel permits an incidental patch-class fix of ten lines or fewer near files
  under edit; here it is expected. Noticing and leaving it is the thing this
  section forbids. Ledger it under `Drive-by fixes` with its files and commit.
- **Outside that envelope, the kernel routes to the patch train or the tracker,
  and this section does not change that.** It adds a burden of proof: a tracker
  issue must name the specific reason the work cannot ship in the branch that
  found it. "Out of scope" is not a reason; "needs a migration window", "changes
  a published contract", or "the design decision is someone else's" are. An
  issue you cannot justify in one sentence is a fix you should be making.
- **This file grants no exception to the bound above, and cannot.** The kernel
  is precedence-bound: a repository, task, or issue instruction may add
  stricter rules, never weaker ones, so none can raise the ten-line envelope.
  An owner who overrides that routing is acting outside the kernel; log the
  override and its scope in the PR body next to the commit it covers. Making it
  the standing default means changing the control-plane kernel.

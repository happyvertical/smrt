# Mail search and private correspondents (#5132)

- `MailSearchService({ db, tenantId, principal })` searches only accounts from
  `listAccounts()` with the `read` scope (owner, grant, tenant ceiling, host
  scope/account ceilings; fail closed). `accountIds` only narrows. Local reads
  are bound to those ids in SQL (`accountId in`), then run under
  `runWithMailSystemAccess` because the decision was made here with the explicit
  principal. Unowned accounts are not listed, so they are not searched.
- `search()`: keyword filters (text, from, to, subject, label, date, flags,
  attachment) are matched case-insensitively in memory over a bounded
  newest-first scan (5000 rows per call; `truncated`/`nextCursor` say more
  exist). SQL `like` is not used for user text (no escaping, case differs
  between SQLite and PostgreSQL). `mode: 'semantic'` ranks with
  `EmailCollection.semanticMatches()` (core `semanticSearchIds`, `where` applied
  before ranking); `Email` embeddings are opt-in (`autoGenerate: false`, hosts
  generate them) and an empty or unavailable ranking falls back to keyword.
- `searchProvider()` asks each readable account's server through the SDK
  `search()` (needs `@happyvertical/smrt-messages/providers/email`) and falls
  back to the local index per account (`fallbackAccounts` says why; the reason
  is a fixed string, never provider text). Label and flag filters the SDK
  criteria cannot express are applied to provider hits before the page is cut. Synced
  provider hits carry `emailId`.
- `Correspondent` (`correspondents`, tenant-required, generated surfaces off) is
  owner-private: unique `(tenant, owner_user_id, address)`, only `address` is
  required. `CorrespondentService.refresh()` recomputes counts, latest name and
  first/last contact from the mail the owner can read (the owner's own account
  addresses are skipped); it never creates or links a `Profile`.
  Each row keeps a per-account breakdown (`accountBreakdown`); `list`/`suggest`/
  `get` build counts, dates, name and `accountIds` from the accounts the viewer
  can read now, and hide a row with none, so revoking access removes that
  account's contribution before the next refresh. `refresh()` changes nothing
  when no account is readable and only replaces the scanned accounts' entries,
  so it never erases data it could not see. Delegated principals (host scope or
  account ceiling, or principal id != user id) get nothing and cannot refresh,
  link or unlink unless the host passes `allowDelegated: true` (the owner's
  consent).
  `linkProfile`/`unlinkProfile` are the owner's explicit choice (profile must
  exist in the tenant). `RecipientInput` takes a host `suggest` callback
  (typically `CorrespondentService.suggest()` for the signed-in user).
  New table: consumers run `db:migrate`.

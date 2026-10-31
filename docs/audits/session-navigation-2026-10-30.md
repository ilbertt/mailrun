# Session navigation and account-switch audit

Historical audit for `d681055`. The [browser-authentication follow-up](browser-auth-2026-10-30.md)
addresses its cookie/bearer, deadline and transient-probe gaps and records current verification.

The original `71aa49b` client AuthGuard fetches `/api/auth/me` with `no-store`
on pathname changes and redirects using current roles. Its primary-only fallback
is `/admin`; ordinary users return to `/inbox`, and a revoked session goes to
`/login`. The source guard hash is
`109ff16a46af765b2fee27c2acc97ada02df83e1335c4ca1430f3575eadf336d`.

Mailrun previously used `ensureQueryData` for the session. The installed query
client returns cached data immediately from that method even when stale, so a
configured 60-second stale time did not provide the intended validation.
Protected and public auth routes now fetch current session data with a zero stale
time, sharing concurrent requests and forwarding cancellation. One typed SQLite snapshot also supplies the timezone and setup flags; the
separate document-preference cache retains its lifetime. Primary-only redirect behavior
now follows the original.

Production browser checks used cloned synthetic workspaces and loopback controls:

| Change while the app is open; next navigation | Original Node/Next | Previous Mailrun `61f57b2` | Updated Mailrun |
| --- | --- | --- | --- |
| Primary flag removed; open Branding | `/admin` | `/branding` | `/admin` |
| Admin role removed; open Domains | `/inbox` | `/domains` | `/inbox` |
| Session revoked; open a warmed Sent page | `/login` | `/sent` | `/login` |

The role test retains a separate administrator so it does not accidentally test
an installation without any administrator. The fixture controls change only
synthetic data; no live account roles or sessions were changed. Backend API
permission checks already rejected unauthorized requests in the preceding build;
the reproduced mismatch was cached client navigation and displayed state.

Four deferred-response regressions failed on the preceding client code: a cleared
message-detail request repopulated its cache, an older forced result replaced a
newer one, an old 401 signed out a newly selected account, and switching away/back
accepted an old draft revision/mutation event. A session generation plus token
comparison now scopes response side effects. Detail caches also check that scope
without relying on React listeners, discard stale returned content, and only let
the owning request publish/remove its pending entry. Current-session 401 responses
still sign out. Storage failures no longer interrupt mailbox cache clearing.

For the browser account-switch check, the loopback proxy held an already
authorized owner message response. The original Add another account form signed
in a second synthetic user. After releasing the old response, browser Back
returned to the old message URL without a document reload. The updated reader
showed `Not found`, with only the second user's mailbox in the list. No former
body was displayed. All test messages are synthetic.

Reproduce the browser fixture with:

```sh
bun scripts/serve-session-fixture.ts --reference /path/to/original-71aa49b \
  --before /path/to/mailrun-61f57b2-host --after ./dist/mailrun-local
```

It prints three loopback URLs. POST `{"action":"delegated"}`, `{"action":"user"}`
or `{"action":"revoke"}` to a fixture's `/_fixture/action`, then use its actual
navigation links. `reset` restores the synthetic owner session for a reload.
`hold-detail` and `release` control the selected synthetic response. The fixture
password is `session-fixture-password`; accounts are `hello@example.com` and
`stranger@example.com`. These values are test-only. Stopping the fixture removes
its synthetic databases and child servers. No fixture endpoint ships in the app.

All 430 behavioral tests, strict TypeScript and SQL checks pass, as do compiled
HTTP/WebSocket checks and 14 focused Linux x64 session/document/cache tests. This
is not the complete URL/permission audit. The updated
[navigation benchmark](../benchmarks/navigation-session-recheck-2026-10-30.md)
includes the session recheck and supersedes earlier faster figures that omitted it.

The source and updated build also refresh a stored timezone on the next
navigation. Sequential isolated browser checks changed the synthetic owner from
device default to America/New_York: the same fixed message changed from Jan 01,
1970 to Dec 31, 1969 in both. The previous build kept Jan 01. With two updated-app
tabs open, the second tab's refresh caused the first tab to reload; the fixture
observed its Inbox document count increase from two to three and both dates
updated. `new-york` is available as a synthetic fixture action.

Remaining browser-authentication gaps include the original cookie-to-bearer
fallback and its five-second/transient-probe-error handling. The native route
probe currently relies on cookies and fails if that RPC fails. This audit closes
the recorded current-role, response-race and timezone cases, not those remaining
paths or the full app's permission/URL matrix.

# Page templates, aliases and message-status endpoint

The reference is original Mailflare `71aa49b`, version 0.5.2. The new
`tests/source-pages.json` records all 72 page templates, their source paths and
SHA-256 hashes. It also records eight unconditional, single-statement redirect
pages. Conditional authentication redirects are deliberately not classified as
static aliases. Regenerate from the pinned reference with:

```sh
bun scripts/snapshot-source-pages.ts /path/to/original-71aa49b 71aa49b
```

The native UI route set now represents those 72 templates, normalizing only
dynamic parameter names and index-route slashes. Infrastructure API/JMAP/MCP
routes are excluded from this page-only comparison. This inventory proves route
representation; it does not establish that every page's complete behavior or
mobile layout has been compared.

## Restored pages and aliases

| Path | Previous native behavior | Updated behavior |
| --- | --- | --- |
| `/compose` | Bare form without the source page heading, description or padded wrapper | Exact original page component and explicit page-mode form |
| `/settings` | Settings shell with an empty index | `/settings/account` |
| `/rules` | 404 | `/settings/account` |
| `/settings/auto-reply` | 404 | `/settings/inbox` |

The migration-only `/settings/forwarding` page is removed. Forwarding retains the
original Account settings controls and existing backend service.

The copied composer page hashes identically to the original source page. Actual
production browser fixtures compare the original, preceding and updated builds:
the heading and description are absent in the preceding build and present in
both original and updated builds. The original and updated browsers also follow
all three restored aliases to the same canonical URL and remove legacy query
parameters. No real account or outgoing email is used.

The compiled smoke checks all eight static alias targets, both bare and with
`mailboxId`, numeric token and encoded path query values. Existing `/audit-logs`,
`/import-export`, `/settings/import-export`, `/register` and `/onboarding` aliases
retain their targets. Native aliases use ordinary 307 responses. The original
Node/Next reference can instead commit a 200 HTML stream containing a logical
307 `NEXT_REDIRECT` payload; browser destination semantics are compared, not that
framework-specific serialized transport.

## Restored legacy status mutation

`POST /api/messages/:id/status` previously fell through to 404. It now accepts the
source statuses `received`, `sent`, `draft`, `trash` and `spam`, returning the source
`{success:true}`, invalid-status and not-found responses. It uses current mailbox
management permissions in a typed SQLite transaction. Ordinary status changes
leave folder, snooze, read and star fields alone; existing database triggers
maintain the retention timestamp on entry to or exit from Trash/Spam. Audit
metadata records `{status}`, rather than a bulk-action substitution.

Spam and ham changes use existing token/reputation training and audit behavior.
For this legacy endpoint, ham preserves the source snooze value; the existing
bulk-action behavior remains unchanged. The endpoint retains native protections
for another author's private draft and a delivery already in flight. Those
stricter native guards are tested separately, not asserted as equivalent source
outcomes by the selected capture.

`tests/source-message-status.json` contains twelve responses and persisted effects
captured through the unmodified original HTTP handler: five accepted statuses,
spam-to-received, invalid archived status, missing message, unshared/read-only/full
access and an outbound-spam refusal. It records message fields, feedback
classification and audit metadata. Only newly generated retention timestamps are
normalized to `now`; native checks require them within the request's time window.
Every case starts from the same explicit folder/snooze/retention state. Source
handler/helper hashes are retained in the capture.

To regenerate, start `scripts/serve-session-fixture.ts` against the pinned
reference and host executables. Use its printed temporary directory and original
loopback origin:

```sh
bun scripts/capture-source-message-status.ts /path/to/original-71aa49b \
  /private/tmp/mailrun-test-example http://127.0.0.1:4700
```

The capture command modifies only that disposable fixture's synthetic message,
grants and training/audit data. It never edits the original source. Stop the
fixture after testing to remove its databases and servers.

Production `POST /api/seed` also now returns the original 403 refusal before
authentication or JSON parsing. Development demo seeding is not covered here.

## Verification and limits

All 461 behavioral tests, SQL generation/coverage and strict TypeScript pass.
Host and emulated Linux x64 compiled HTTP/WebSocket suites verify the aliases,
production seed refusal and actual cookie-authenticated status writes. Twenty-one
focused Linux page/status/mail tests pass. No persisted table, schema migration
or backup list is changed; statuses, spam feedback and audit records use their
existing backed-up tables.

This closes the recorded page/alias/status gaps. The complete allowed-handler,
permission, metadata and URL/query matrices, every rendered page/mobile flow,
external protocol interoperability, full original-data cutover and native guest
resource verification remain open. The page count and method inventory must not
be presented as proof of full parity.

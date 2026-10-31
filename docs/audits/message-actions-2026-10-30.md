# Single-message actions and shared-mailbox permissions

The pinned reference remains Mailflare `71aa49b`, version 0.5.2.
`tests/source-message-actions.json` contains 50 actual original HTTP responses
and their persisted message/audit effects. Handler, date utility, mailbox access
and audit-helper hashes accompany the capture. It uses only disposable synthetic
accounts and files; source code is not modified.

The first 48 source-backed cases reproduce 34 failures in the preceding native
implementation. The original allows read-only, send-on-behalf and send-as
collaborators to star messages they can read. Native code incorrectly required
management access. The single-message read handler also substituted bulk-action
JSON/audit metadata, and snooze applied stricter date parsing and different error
responses/order.

## Restored contracts

| Action | Required access | Response and effects |
| --- | --- | --- |
| `POST /api/messages/:id/read` | Read | `{success:true}`, set read, record `email.read` with null metadata, including repeated reads |
| `POST /api/messages/:id/star` | Read | Toggle star and return `{starred:boolean}`; no extra audit event |
| `POST /api/messages/:id/snooze` | Manage; received inbound mail | `{ok:true}`, preserve unrelated fields and store the parsed future time in seconds |
| `DELETE /api/messages/:id/snooze` | Manage; inbound mail | `{ok:true}`, clear snooze on inbound mail even when archived |

Source-valid offset ISO dates, date-only values and RFC dates now work. Invalid,
empty, null, numeric and past values return `Choose a future snooze time`.
Validation precedes message lookup for POST, including a missing message ID.
Missing/inaccessible, disabled-mailbox and unsupported direction/status cases
return the source `Message not found` response. Unknown imported grant strings
do not acquire read access. Read/star/DELETE ignore bodies as the source does.

Authorization reads message ID, mailbox, status and direction in the same SQLite
transaction as the mutation. Star toggling retains the atomic SQL update. The
single-message read no longer runs an unrelated bulk action or emits its metadata.
The existing native private-draft boundary remains separately tested; foreign
private drafts are not included as source-equivalent positive cases in this
capture. This is not a complete permission or malformed-request matrix.

## Browser proof

Three production builds used matching synthetic Team mailboxes with a read-only
grant to a second user. The actual Add another account form signed in that user,
and the account menu selected the shared inbox. The source and updated build
both allowed a star click and displayed the shared message in Starred. The prior
`7efcc80` build kept the star off and its Starred list empty.

Independent fixture database reads after the clicks confirmed the same outcome:
source `starred=1`, prior `0`, updated `1`, each with the `read_only` grant, unchanged
`read=0` and `status=received`. No live account, grant or message was modified and
no external email was sent. Temporary browser tabs, servers and databases were
removed after the comparison.

## Reproduction and verification

Start `scripts/serve-session-fixture.ts` using the pinned original Node/Next
production checkout, a prior host executable and the updated executable. It
prints its disposable directory and three loopback origins. Capture the source:

```sh
bun scripts/capture-source-message-actions.ts /path/to/original-71aa49b \
  /private/tmp/mailrun-test-example http://127.0.0.1:4740
```

The capture command changes only its synthetic fixture's grants, flags, folder
and audit records. Run it against a fresh fixture before the browser setup; the
last captured case deliberately disables its synthetic mailbox. Stop the fixture
when finished. Ordinary builds/tests use the checked-in JSON without a source
checkout.

All 512 behavioral tests, generated SQL/coverage and strict TypeScript pass.
Host and emulated Linux x64 compiled HTTP/WebSocket checks verify actual read,
star, offset snooze and unsnooze requests, exact JSON, null read-audit metadata and
persisted time. Seventy focused Linux source-action/status/mail tests pass, plus
the additional private-draft boundary regression. No schema migration, table or
backup list changes are needed; existing messages and audit tables remain backed
up normally.

The broader allowed-handler, URL/query/metadata, permission and mobile matrices,
external client interoperability, full original-data cutover and native guest
resource gates remain open. These selected captures do not prove full parity.

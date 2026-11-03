# Original public send API

Mailflare `71aa49b` (v0.5.2) runs `/api/v1/send` through its shared sender and
queue service. The previous Bun implementation used a separate publication path,
with different validation/error responses, queued payloads and attachment
metadata. The initial 69-case comparison matched 25 cases and differed on 44.

## Reference evidence

`tests/source-v1-send-contracts.json` records 72 executions of the unmodified
original POST handler. The harness imports the original API-key authenticator,
bcrypt verification, sender service, SQLite adapter and FileBucket. It provides
synthetic mail/queue bindings and a Gravatar 404; other external fetches fail.
Source hashes accompany the capture. Authentication and authorization are not
stubbed, and no actual mailbox, Cloudflare credential or external delivery is
used.

Cases cover owner/delegated grants, disabled mailboxes/accounts, personal/shared
mailboxes, licensing, Bearer/Basic/missing/invalid credentials, scope combinations,
explicit/empty/unrestricted mailbox grants and legacy MCP-kind keys. Request
cases include required fields, subject limits, recipient normalization and
single-label addresses, threading, combined recipient limits, scheduled/past
sends, malformed/null/array/empty JSON and the declared 40-MiB limit. Attachment
cases include MIME defaults/case/whitespace, original versus safe filenames,
NUL/path/blank names, whitespace/unpadded/empty/invalid base64, count/size limits,
decode-before-sender versus scope-before-decode ordering, and provider failure.

Comparison checks responses, source message/job/file/contact/audit fields,
provider wire data, object keys/hashes and the API key's last-used marker.
Generated IDs and current timestamps normalize as in the existing source-send
fixture. The original error text is retained; native invalid-base64 failures are
translated from Bun's DOMException wording to the original response.

```sh
bun scripts/capture-source-v1-send.ts /path/to/original-71aa49b
bun test tests/source-v1-send.test.ts tests/v1-send-guards.test.ts
bun scripts/smoke-v1-send.ts dist/mailrun-local
```

## Native behavior

Public sends now use the same typed publication service as session sends, with
original-format durable payloads and independent attachment objects. Sender,
recipient, threading, contact and scheduling behavior share the already compared
source path. Current API-key/account/mailbox rights are checked again inside the
publication transaction after file copying. Revocation prevents message/job/file
publication and removes the copied private objects.

Immediate delivery uses submitted filename/MIME metadata while storage retains
safe filenames. Scheduled delivery reloads the saved file metadata, matching the
source worker. Both preserve exact bytes and the original queued envelope.
JSON parsing returns an empty object for a zero-byte body; malformed documents
retain their distinct body error rather than a schema error. Declared and actual
body limits remain bounded, and staged JSON is removed on every exit.

Public API keys honor `mailbox_scope_enabled` independently of their `kind`.
MCP is a separate source protocol: it always uses explicit mailbox grants.
Its authenticator requests those grants even when a legacy flag is off, and
live mutation checks still require the mapping. New managed mail/MCP keys keep
explicit scope enabled. No key grants, scopes or stored flag are rewritten.
Header CR/LF guards and author-only draft access remain in place.

No persisted table, migration or backup format/list/group changes are introduced.
The existing 0070 snapshot trigger captures the new public sends automatically.

## Verification and limits

The direct comparison passes all 72 cases alongside the 83 session-send and 51
queued-worker cases. Five additional guards cover key deletion, send-scope
removal, mailbox-scope removal and account disable during attachment copying,
and live MCP mailbox revocation with the legacy flag off. The older JSON parser
test now distinguishes the original empty-body behavior from malformed and
whitespace-only documents.

The compiled rehearsal compares all 72 responses/state/wire/object outcomes over
HTTP, including an oversized declared Content-Length sent without allocating its
body. It also stops HTTP, revokes the submission key, runs the scheduled CLI,
checks the original queued payload and attachment bytes/metadata, replays the
worker without duplicate delivery and verifies the revoked key after restart.
The provider is isolated on loopback TLS. Oversized cases also check missing,
invalid and read-only keys. Their intentionally incomplete HTTP requests use
separate connections, since reusing a connection with an unfinished declared
body cannot represent another request.

The full host check passes 1,901 tests, SQL generation/coverage and TypeScript;
the later three oversized-authentication cases also pass in the 136-test focused
API/key/MCP run. The production host build and compiled 72-case public API,
83-case session-send/cancel and 51-case queue rehearsals pass. The first sandbox
run could not bind several loopback fixtures; rerunning with socket access
passes. Two old assertions were corrected against direct source evidence:
zero-byte bodies decode as `{}`, and public API scope flags are separate from
MCP's mandatory explicit grants; that assertion now exercises the MCP
authenticator directly.

[Native Ubuntu CI 41616965845](https://github.com/ilbertt/mailrun/actions/runs/41616965845)
and independent PR run 41616977223 pass all 1,904 tests, SQL generation/coverage,
TypeScript and every compiled HTTP/WebSocket/parity rehearsal. These include
all 72 public-send comparisons and the revoked-key/restart/attachment journey,
the 83 session-send/cancel and 51 original queue outcomes, source record restore,
and existing preferences, mailbox/sharing, routing, upload and feature checks.
The selected one-CPU/256-MiB/no-swap rule workload passes with 116,191,232-byte
cgroup peak and zero OOM kills. This is not whole-guest cold/concurrent capacity
or a capacity test of maximum-sized public sends.

Source `391d6c3` was deployed on November 3 through the nibrun CLI to the existing
preview, deployment `01a1a0ef-7a3b-7612-a14b-30a7916f278f`. The downloaded Linux
ELF executable matches its CI manifest: 119,396,320 bytes, SHA-256
`69cdd7c27f443d8c4b2011fb587e6b2128e40196c827ae86967c0388712057ea`.
Artifact 13221723489 has archive SHA-256
`6f41eb00d2e0a68d0a1eb6e91043c6cd9eb4d965dd5c64437f9d4ddfa25375f3`;
the CLI used that digest for the server's verified archive fetch. Deployment
started only after the local artifact download and executable check completed.

Immediately before release, no send/domain operation was active, with one
account and five messages present. After release, login/setup return HTTP 200,
the installation is ready, the same account/message totals remain, migration
0070 is applied once and all linked jobs have transport snapshots. ilbert.dev
remains active with routing/sending enabled. The existing Cloudflare Worker
returns HTTP 200 after a successful signed callback, and all three UTC cron
jobs are registered for the new deployment. The relay check uses credentials
from the previously approved private recovery copy without displaying them.
No live email, account/message mutation, provider/credential edit, schema
migration or restore/reset was performed for these release checks.

This closes the selected public-send producer matrix. JMAP, assistant/calendar
and other protocol producers, broader wire/MIME/provider and temporal cases,
rendered/mobile/keyboard workflows, real client interoperability, original-data
cutover and whole-guest cold/peak/concurrent capacity remain open. The original
Vinext/Cloudflare performance baseline and the owner's shared-draft-body policy
decision also remain open. These captures do not establish full parity.

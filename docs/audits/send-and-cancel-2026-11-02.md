# Original send forms and scheduled cancellation

Mailflare `71aa49b` (v0.5.2) creates a separate outbound message and independent
file copies when `/api/send` is called with a draft. The draft remains until the
composer removes it after success. Native reused the draft as the sent message,
accepted only multipart data, validated different fields and changed response/
cancellation errors. JSON sends and source-compatible failure/retry behavior
therefore diverged despite the existing provider/queue tests.

## Reference evidence

`tests/source-send-contracts.json` records 83 original handler responses, every
source message/job/attachment column, touched contacts, audits, actual mail-binding
payloads and remaining object hashes. Original handlers, validators, sender,
scheduler, auth/session, SQLite and FileBucket hashes are pinned. Capture executes
their unmodified functions with genuine Bearer-session authentication. Only the
environment/mail/queue bindings are supplied by the harness; unused cookie
fallback traps rather than inventing a user. Mail/queue calls are recorded in
memory and external fetches fail the capture. No email is sent.

Cases cover JSON and multipart input, recipients/threading, sender/shared grants,
subject/body/schedule validation, header/recipient limits, existing/foreign/AI
drafts, new plus stored files, missing objects, independent outbox copies,
provider failure and queued/claimed/unscheduled cancellation states. Dynamic IDs
and current timestamps are normalized; the request-origin value is normalized
as instance-specific context. Original job payloads are parsed for structural
comparison. The complete remaining object inventory detects lost/orphaned files.
This is original handler/binding evidence, not Next outer-error-framing proof.

```sh
bun scripts/capture-source-send.ts /path/to/original-71aa49b
bun test tests/source-send.test.ts tests/session-send-races.test.ts
bun scripts/smoke-send.ts dist/mailrun-local
```

The preceding code matched ten of the initial 80 cases and failed 70. Expanded
captures add combined-recipient/rendered-header limits and immediate mixed-file
order. The updated code matches the source cases; final complete-suite and native
Linux release results are recorded below when available.

## Native behavior

- The session send adapter uses the original form/JSON schema and validation
  order, schedule tolerance, sender errors and AI-review refusal. Multipart
  parsing shares the bounded parser used by draft uploads. Subject-only sends
  and recipient/reference arrays retain source behavior. The public v1 API
  remains the separate supported JSON attachment interface; arbitrary JSON
  attachment objects/outer malformed-input framing are outside this comparison.
- Submission snapshots parsed fields into a new queued message, job and
  independent streamed file copies. Existing draft content is preserved.
  Contacts, canonical threading, exact optional/null fields, payload metadata,
  source file naming/disposition and request order survive. Empty CC/BCC/header
  objects are omitted from Cloudflare transport as in the original binding.
- A draft lock and revision touch fence competing browser submissions without
  keeping the mutable original linked to its queued copy. The response carries
  the submitted revision even on provider failure; late cleanup cannot discard
  a newer edit. Current mailbox grants are rechecked in the publication
  transaction; a revoked sender leaves no queued copy or staged files.
- Cancellation uses the source read/send permission split and exact ordinary
  statuses/errors. A write fence serializes its current-grant/scheduled-job
  checks with other processes' delivery claims. Only waiting scheduled jobs are
  deleted; message status returns to Drafts and unrelated source fields remain.
  Native revision/schedule-cache fields are updated internally.

No persisted table, schema migration, backup table/group or format changes.
Existing native author-only draft protections remain; this change does not
resolve the owner's shared-reader draft-body choice.

## Verification and remaining scope

All 1,292 host tests, SQL/type checks and the compiled HTTP/WebSocket suite pass.
Six additional guards test copied-message survival after
original edit/delete, one-copy submission for a shared revision, late-cleanup
conflicts, sender revocation while copying, and both cancellation/claim winners
against a real separate Bun delivery process using loopback transport.

The standalone source comparison uses real HTTP auth and isolated HTTPS
Cloudflare transport. It checks rows, payloads, wire data and objects, then
deletes the original draft, stops HTTP, delivers the copy through cron and
restarts. Cancellation also survives restart and a subsequent cron run without
delivery. Existing isolated Resend/SES checks pass 24,000,003-byte attachment
delivery, provider failure and cron recovery; those runners now follow the
returned outbound message ID rather than the original draft ID. Native Linux
verification and preview deployment are pending for this checkpoint.

Ambiguous external-provider outcome handling, other recipient/header/malformed
wire cases, broader source/provider/client and rendered/mobile/keyboard flows,
full data cutover, and native whole-guest cold/concurrent memory/capacity gates
remain open. Selected captures do not establish full parity.

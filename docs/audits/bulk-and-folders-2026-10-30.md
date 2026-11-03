# Bulk actions and folder contracts

`tests/source-bulk-contracts.json` records 84 actual responses and persisted
effects from unmodified Mailflare `71aa49b` / 0.5.2. The original bulk, empty-folder,
folder, spam and deletion helpers are hashed, together with the supported Node
runtime's FileBucket adapter. The preceding native code fails 46 of these cases.
The updated services and standalone HTTP executables pass all 84.

## Restored behavior

- Bulk actions retain source validation/error messages, filter empty/falsy IDs,
  deduplicate effective work and accept valid lists beyond the former arbitrary
  10,000-element cap. The server's existing body-size boundary remains in force.
- Ordinary moves and flag changes rely on the existing retention triggers.
  Repeating Trash preserves its original timestamp instead of extending retention.
  Unrelated metadata remains unchanged.
- Bulk audit records retain the source mailbox/null fields and action metadata.
  Normal Inbox restores do not invent a delete audit event. Spam/ham training and
  its audit retain source behavior, including the source's snooze handling.
- Empty Trash/Spam uses the original 100-message batch and reports `remaining`.
  A 101-message fixture returns 100 deletions and one remaining item on its first
  request. Batch selection order is not asserted where the source provides none.
- Folder GET returns the complete original fields: ID, owner user ID, mailbox ID,
  name, color and ISO creation time. It performs a dedicated folder query instead
  of assembling aliases, rules, forwarding and other settings.
- Folder creation uses the existing copied source validator: trimmed names up to
  80 characters, the eight-color palette, default blue and the source error
  structure. Delegated creation records the mailbox owner's ID. Duplicate names
  remain atomic failures.
- Shared read permission accepts only the four recognized source grants. Unknown
  stored permission strings do not become read rights.

Capture cases cover owner/read-only/send-on-behalf/send-as/full-access/unshared
actors, mixed-access selections, repeated moves, invalid actions and folders,
duplicate/falsy IDs, 10,001 repeated IDs, permanent-delete skips, object cleanup,
empty-folder validation/batching and folder listing/creation/validation.

The permanent-delete cases use only synthetic raw MIME, attachment bytes and a
shared-link row in a disposable directory. Live-mail deletion is skipped with
files and links intact. Deletable Trash/Spam removes rows, links and both objects.
Remaining bytes are checked by SHA-256, not merely a success status. Native
private-draft, in-flight delivery, cross-mailbox folder and shared-object safeguards
remain in place; the selected source captures do not establish identical outcomes
for those stricter safeguards.

## Actual UI check

Original, prior `f01f264` and updated production browser fixtures start with the
same archived synthetic message. Selecting it and clicking Unarchive restores it
in all builds. Independent database reads find audit counts 0 / 1 / 0 for that
operation; the prior record is `email.delete` with `bulkAction:inbox`. This is an
audit-data comparison, not a claim about the authentication-only Activity screen.
The updated UI also creates a folder with the normal popup, moves the message
through the bulk Move to menu and displays it in that folder. No live message or
account is changed and no external email is sent.

## Reproduction and evidence

Start `scripts/serve-session-fixture.ts` with the pinned original Node/Next build
and host executables. Capture against its printed original origin and temporary
directory:

```sh
bun scripts/capture-source-bulk.ts /path/to/original-71aa49b \
  /private/tmp/mailrun-test-example http://127.0.0.1:4780
```

This changes only the synthetic fixture's rows and `blobs/bulk-contract` files.
It never edits the reference source. Ordinary tests need only the checked-in
capture. Request-body hashes guard the shared input recipes. Generated folder IDs
and current timestamps are normalized; selected message fields, folder records,
response JSON, audit data, feedback classification, attachments/links and object
bytes are compared. Large empty-folder cases compare counts rather than
unspecified remaining-row order.

The same capture also runs through the compiled server with real authentication:

```sh
bun scripts/smoke-bulk-contracts.ts dist/mailrun-local
```

On Linux x64 use `dist/mailrun`. All 84 cases pass through both host and emulated
Linux x64 compiled HTTP servers. The full 596-test behavioral suite, SQL generation
and coverage, strict TypeScript and normal host/Linux HTTP/WebSocket suites pass.
No schema migration, persisted table or backup table list is changed.

These cases close the recorded bulk/folder differences. Full allowed-handler,
permission, URL/query/metadata, mobile, interoperability, original-data cutover and
native guest resource gates remain open; this capture is not full-parity proof.

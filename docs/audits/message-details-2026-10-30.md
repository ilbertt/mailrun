# Message details, threads and attachment reads

The unmodified `71aa49b` / 0.5.2 production handlers generated 104 HTTP captures
covering message details, metadata, threads and attachment downloads. Their module
hashes and responses are retained in `tests/source-message-details.json`.
The preceding `5e24868` standalone binary fails 86 cases; the updated host
standalone binary passes the selected contracts. Linux x64 verification is pending
because the local container engine is not responding. Four additional native
permission checks retain author-only access to another user's draft body/files;
those checks are explicitly outside the source-parity count.

## Corrected contracts

- Detail responses preserve all original message columns in both `message` and
  `body`, including stored text/HTML, original retention timestamps and the legacy
  `rawR2Key` field. Native revision/delivery columns are excluded. `message` adds
  the source's two nullable contact names; the extra avatar flag and top-level
  scheduled timestamp are removed from this endpoint. Queued details do not
  accidentally use the differently shaped legacy owner-only helper.
- Metadata and detail attachment arrays retain source order and omit trashed
  files. Unsubscribe extraction reads at most the original 64 KiB of raw headers,
  preferring HTTP(S), falling back to mailto and tolerating absent raw objects.
- Metadata authorization selects only the message reference and access fields;
  it no longer materializes full bodies. The thread route reuses its authorized
  reference instead of performing a preceding full-record lookup.
- Threads retain original fields, body data, owner-scoped contacts, avatar flags
  and attachment metadata while excluding the raw object key. An empty thread ID
  behaves like an absent thread ID. Real conversations exclude Drafts/Trash,
  remain in the requested mailbox and return the oldest 200 rows. No thread is
  synthesized across mailboxes merely because their stored IDs coincide.
- Missing, disabled, inaccessible, unknown-grant and orphan detail/thread requests
  return the source JSON `Not found` response. Shared reads use recognized grants.
- Attachment downloads copy the original disposition helper: quoted names replace
  quotes, backslashes and CR/LF with underscores. The original preview flag is
  honored, the migration-only `inline=1` shortcut is removed, and explicit download
  overrides preview/inline disposition. Safe MIME essence/charset behavior is
  retained; HTML/SVG do not render inline. Successful files use the source private
  one-hour cache policy. Missing/trashed/wrong-message files return plain `Not found`.
- An attachment on an orphan message is available to its owner, matching the
  original ownership fallback; another user is denied. This does not grant access
  to orphan message detail or thread endpoints.

Mailbox authorization accepts an existing typed database context when called
inside a serialized database callback. The compiled download checks exposed a
nested callback deadlock in the initial patch; the corrected implementation reuses
that context and all download cases complete. Ordinary callers retain the same
query/permission behavior. No schema, persisted table or backup table/group list
is changed.

## Evidence and reproduction

The fixture includes inbound/outbound, queued, draft/template, Trash/Spam, shared
and foreign mailboxes, orphan messages, differing contact books, blank/missing
contacts, nullable/empty thread IDs, mixed-author conversations and 205 additional
thread members. Attachment cases include safe preview types, blocked active types,
Unicode and malformed filenames, inline/attachment dispositions, missing objects,
trashed files and wrong-message IDs. The corpus verifies original metadata and
actual download bytes by SHA-256; the fixture's PDF/image bytes are transport
samples, not proof of preview rendering.

Capture against the pinned original production backend directly, rather than the
browser-fixture proxy which removes Content-Length:

```sh
bun scripts/capture-source-message-details.ts /path/to/original-71aa49b \
  /private/tmp/mailrun-test-example http://127.0.0.1:4847
bun test tests/source-message-details.test.ts
bun scripts/smoke-message-details.ts dist/mailrun-local
```

The capture requires the known disposable fixture identity and a loopback URL.
Normal checks need only the checked-in original capture. JSON fields, values,
array order and statuses compare exactly. Successful download checks compare MIME,
disposition, declared length, cache policy, nosniff and actual byte length/hash.
Error response Content-Length is excluded because Node and Bun frame short errors
differently. The original Node response encodes the legacy Unicode filename header
as UTF-8 bytes read as Latin-1; comparison decodes that source header once to its
filename intent. The capture itself remains unchanged. This is a functional header
comparison, not a claim of identical HTTP wire encoding or every global CSP header.

The full 794-test suite, generated SQL/coverage and strict TypeScript pass.
The host artifact passes all 104 selected contracts and the four separate native
draft-read denials, plus the regular HTTP/WebSocket suite. The Linux artifact is
built, but its two verification processes are still waiting on the unresponsive
local Docker engine; even the engine's status and bounded socket ping cannot
complete. Verification uses the existing local amd64 image with external networking
disabled. The preview has not been updated with this patch. No real account, sharing grant, message or file is modified, and no
external email is sent by these tests.

The prior [mailbox audit](mailbox-reads-2026-10-30.md) records the pending owner
choice about other authors' draft bodies. Existing native draft restrictions are
retained here, including metadata on a foreign draft; this corpus does not claim
full original draft visibility parity. Arbitrary timestamp ties, all rendered
preview formats, full mobile/client interoperability, complete populated source
cutover and native guest resource/cold-start gates also remain unproven.

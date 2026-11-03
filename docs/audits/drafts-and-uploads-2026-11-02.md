# Original draft and attachment contracts

The original composer appends the attachment rows returned by an upload. Native
uploads returned the complete existing list, so a second upload could duplicate
previous files in the composer. Native draft collection GET was also missing;
save responses, snippets, null body/subject values and assistant schedule edits
differed from Mailflare `71aa49b` (v0.5.2).

## Evidence

`tests/source-draft-contracts.json` contains 60 actual original HTTP responses
with their persisted message/attachment/assistant state and object byte hashes.
The original handlers and helpers are unmodified; their hashes are recorded in
the capture. Generated message/attachment IDs and current edit/create times are
the only normalized values. Object-key structure, field presence, ordering, nulls,
content types and hashes remain compared. The complete remaining object inventory
is compared separately from metadata rows, detecting orphaned files after delete.
Only original FileBucket metadata sidecars are excluded from content inventory.

```sh
bun scripts/serve-session-fixture.ts \
  --reference /path/to/original-71aa49b \
  --before /path/to/previous-host-binary --after dist/mailrun-local --port 4780
bun scripts/capture-source-drafts.ts /path/to/original-71aa49b \
  /path/to/printed/mailrun-test-directory http://127.0.0.1:4780
bun test tests/source-drafts.test.ts tests/draft-form.test.ts tests/drafts.test.ts
bun scripts/smoke-drafts.ts dist/mailrun-local
```

The preceding standalone host binary passes three and fails 54 of the initial 57
cases. Three added cleanup cases expose two more failures after the first fix:
removing an already trashed attachment returns 404, and discarding its draft
leaves that file on disk. Both are corrected; all 60 cases pass. The fixture uses synthetic
users and files on loopback; it sends no email and changes no provider resources.

## Behavior

- Collection GET returns the original newest 100 author-owned outbound drafts,
  optional mailbox filter and complete source fields. Detail GET retains source
  owner/status semantics, including historical inbound-direction draft records.
- POST returns `{draft:{id,attachments}}`; PATCH returns `{draft:{id}}`.
  Revision/identity headers remain available, with strong stale-write checks and
  private no-store/no-transform responses. HTTP callers supply the original
  selected mailbox/from pair. Sender errors and shared send grants match the
  source captures; foreign authors and non-draft records remain inaccessible.
- Saves use the original HTML/text snippet builder and nullable empty bodies and
  omitted subjects. Updates preserve existing threading. Assistant edits retain
  an omitted schedule, explicitly clear null, accept future offset timestamps,
  reject missing timezone/past values and retain mailbox ownership constraints.
- Upload responses contain only newly added rows, in request order, including
  source metadata. Removal returns `{ok:true}`. Empty fields/files are ignored;
  missing files, invalid form bodies and count/size errors use source responses.
  Uploads remain atomic and revision-checked. Filenames use the original
  trim/slash/backslash/NUL sanitation rather than truncation.
- `@remix-run/multipart-parser` is pinned to 1.1.0. A streaming request counter
  enforces the original 30 MiB multipart limit including headers; it avoids first
  copying the whole raw body. Explicit and streamed overflow tests verify 413
  and stream cancellation. The parser retains MIME headers Bun loses for the
  captured whitespace/NUL filename. Original literal-backslash filename behavior
  is preserved before sanitation. File parts are still buffered; this is not
  proof of the full nibrun concurrent memory budget.
- Forwarding copies independent objects with source metadata/order, skips absent
  objects and excludes trashed files. Imported messages with more than ten
  attachments can be forwarded into a draft as in the source; send-time limits
  remain separate. Local copies consume file objects directly rather than
  materializing every file's bytes again. Failure cleanup and draft ownership
  protections remain in place.
- Attachment removal can delete a file already in attachment Trash. Draft
  discard snapshots every attachment key, including trashed ones, in the same
  transaction that removes the draft. Unreferenced file cleanup retains objects
  still used elsewhere. Full inventory checks cover normal and trashed removals,
  discard and raw MIME cleanup; deleting metadata alone cannot satisfy them.

No persisted table, schema migration, backup table/group or format changes.

## Validation and limits

All 870 host tests, generated SQL/coverage and strict TypeScript pass with
loopback networking enabled. The first sandboxed full run could not bind sockets
for three existing webhook/IMAP tests; the complete authorized run passes them.
The compiled normal HTTP/WebSocket suite and isolated Resend/SES rehearsals pass,
including 24,000,003-byte attachments, provider failure and cron recovery. Those
rehearsals now obtain revisions from headers instead of native-only response
fields and supply the original `from` input.

The expanded 76-case focused suite and standalone comparison pass.
[Ubuntu CI 41421004298](https://github.com/ilbertt/mailrun/actions/runs/41421004298)
passes all 870 tests, SQL generation/coverage, strict TypeScript and the compiled
HTTP/WebSocket, mailbox-read, message-detail, draft, upload, populated-feature and
original-record restore rehearsals. Its draft comparison passes all 60 contracts,
including complete remaining object inventory.

On November 2 the exact CI-tested source `2bf9743` executable was checksum-verified
and deployed through the nibrun CLI's server-side archive download path to the
existing preview. Executable SHA-256:
`7410849a3a187f55956819a27ca74bb4061022dcfd86a808004f672ca789ed49`.
The published archive digest
`fb6547cfe357773a28350aba72bb421b7991f87676c2952a6677d9e4a981734c`
was supplied to nibrun; its extracted artifact digest matches the verified
executable. Deployment `01a19b9c-48cb-73ce-bfb8-37c9ea1e563b` is running.
Public login/setup return 200; read-only checks retain one account and five
messages, ready installation and active ilbert.dev routing/sending. The relay
returns 200 with a successful signed callback. All three native UTC cron jobs
are registered against this deployment. No live draft/mail mutation, restore,
email send, data reset or credential change was used for these release checks.

The original browser composer displayed the first synthetic file as saved. The
second file chooser lost its backend node and did not complete, so no paired
browser workflow or visual parity claim is made. Both disposable fixture groups
were stopped afterward. Rendered/mobile/touch/keyboard comparisons, other draft
payload/error/concurrency combinations, client/provider interoperability, original
data cutover and native guest peak/cold-start checks remain open. This audit does
not resolve the separate shared-reader draft-body permission decision.

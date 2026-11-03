# Mailbox list, count and navigation contracts

The original `71aa49b` / 0.5.2 production server generated 116 read captures:
105 session-authenticated list/count/navigation cases and 11 public API cases.
The original handlers are unchanged; `tests/source-mail-reads.json` records their
hashes and actual HTTP responses. Synthetic owner/viewer accounts exercise mixed
message states, two accessible boxes, an inaccessible box, an orphan message,
multiple recipients, different address books, scheduled jobs and attachment metadata.

The updated implementation matches 115 original captures. The remaining case
explicitly preserves the native public API's author-only draft-body restriction,
which differs from the source. It is not counted as source parity. The previous
`f47c440` standalone binary fails 86 of the 116 checks when that native restriction
is included in the expected behavior; the updated host and Linux x64 binaries
pass all checks. No real mailbox, sharing grant, credential or email is used.

## Corrected behavior

- List metadata includes `grouped`, retention timestamps, source default thread
  counters, nullable contact names and scheduled timestamps only for scheduled
  queries. Bodies and raw object keys stay outside the list response.
- Conversation grouping uses the source thread key across the accessible scope.
  The badge counts the whole conversation excluding Drafts/Trash; grouped unread
  counts and member IDs describe only the current filter. Explicit Drafts queries
  remain ungrouped. Whole-conversation statistics aggregate once for the page.
- Contact labels use each message owner's address book and the first To address.
  Outgoing labels respect the primary personal account name or mailbox name.
  The contact query joins the page's addresses to the existing user/email index.
- Shared-inbox list metadata and folder counts include drafts visible under the
  source inbox read scope. Draft editing and the public API's draft bodies retain
  their author-only restriction. This corrects the earlier blanket assumption
  that source list/count endpoints hide other authors' drafts.
- Read scope checks active mailboxes and recognized sharing grants with a dedicated
  query. It avoids constructing unrelated aliases/sender settings just to list
  messages or count folders. Empty scoped keys never fall back to an owner's mail.
- Empty filters, ignored flags, unknown statuses, trimmed searches, first duplicate
  URL parameters, zero/negative limits and clamped negative offsets follow the
  captured source behavior. The existing public API retains template inclusion.
- Navigation now reads only IDs, direction, thread and stored read state. Individual
  navigation uses that row's inbound unread flag. Grouped navigation ORs inbound
  unread across its members even when the newest representative is outbound.
  Its eight valid folders, filters and error responses match the source.
- Attachment searches include stored attachment metadata as the source does;
  inline-only rows do not match. Multiple queued schedule records resolve to the
  source's final stored scheduled timestamp rather than the minimum timestamp.

No persisted table, schema migration or backup table/group list is changed.

## Reproduction

Start `scripts/serve-session-fixture.ts` with the pinned original Node/Next build,
a prior host executable and the updated host executable, then use its original
loopback origin and disposable directory:

```sh
bun scripts/capture-source-mail-reads.ts /path/to/original-71aa49b \
  /private/tmp/mailrun-test-example http://127.0.0.1:4820
bun test tests/source-mail-reads.test.ts
bun scripts/smoke-mail-reads.ts dist/mailrun-local
```

The capture requires the known synthetic fixture identity and loopback URL. Normal
checks use the checked-in capture without running or modifying the original.
Only unordered thread-member sets and count mailbox arrays are normalized; visible
message order, metadata, counts and response status remain exact comparisons.
The public API privacy exception is applied explicitly by `readExpectedBody`;
the original captured body remains intact. Tests label that case separately.

The 716-test full suite, generated SQL/coverage and strict TypeScript pass.
Host and emulated Linux x64 standalone checks pass all read cases and the regular
HTTP/WebSocket suite. Linux verification uses a local amd64 container with external
networking disabled; it does not establish native nibrun memory/latency limits.

## Endpoint measurement

[Raw samples](../benchmarks/mail-read-endpoints-2026-10-30.json) record sequential
before/after host executable runs against identical 10,000-message/1,000-contact
synthetic fixtures. Each endpoint has five warmups and twenty measured requests,
including session authentication and complete JSON parsing, with no added latency.

| Endpoint | Prior median / p95 | Updated median / p95 |
| --- | ---: | ---: |
| Grouped Inbox list | 20.27 / 20.47 ms | 18.47 / 18.66 ms |
| Grouped search | 24.16 / 24.99 ms | 23.20 / 23.55 ms |
| Folder counts | 10.39 / 10.95 ms | 10.02 / 10.62 ms |
| Empty Starred navigation | 4.91 / 5.31 ms | 3.57 / 3.94 ms |
| Grouped Inbox navigation | 31.71 / 33.24 ms | 5.67 / 6.36 ms |

Reproduce with `bun scripts/smoke-mail-reads.ts <host-binary> --measure` for each
binary sequentially. The prior binary deliberately reports its contract failures
after printing measurements. Binary hashes, individual samples and fixture sizes
are retained. This measures server endpoints on macOS arm64/Bun 1.4.4; it does not
measure browser rendering, the original runtime or nibrun guest performance.

## Remaining differences and gates

Automatic approval review rejected matching the source public API's ability to
return another author's draft body to a shared-mailbox reader. That behavior is
not shipped; the user has been asked to choose the intended permission rule.
Recognized-grant enforcement also intentionally rejects corrupted/unknown grant
strings. Malformed nonnumeric/fractional pagination remains typed validation,
rather than reproducing incidental original SQL failures. These captures do not
establish arbitrary query, timestamp-tie ordering or complete permission equality.

The wider full-parity goal remains active: other allowed handler/metadata/permission
combinations, complete populated original-data/R2 cutover, mobile and external
client interoperability, and native guest resource/cold-start gates remain open.

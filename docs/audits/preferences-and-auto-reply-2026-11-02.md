# Original account preferences, mailbox settings and automatic replies

Mailflare `71aa49b` (v0.5.2) is the reference. The migrated settings handlers
returned different validation errors and did not freeze legacy recurring events
when changing the account timezone. Mailbox signatures and automatic-reply text
also missed source trimming/defaults, and primary mailbox renames left identity
contacts stale. Automatic replies differed in case-insensitive suppression,
saved sender/contact/thread fields and queued payloads.

## Reference evidence

`tests/source-preferences-contracts.json` records 171 calls to the original,
unmodified profile, forwarding, shortcuts, spam, recipient-address, trash
retention, timezone and mailbox detail/update handlers. Capture uses genuine
Bearer sessions and the original SQLite/FileBucket adapters. It compares
status/body, relevant account fields, complete mailbox/contact rows and complete
calendar rows. Source hashes include handlers, parsers, validators, identity
sync, address/access rules and time utilities. The original code matched 65 of
these cases before the fixes and differed on 106.

Cases cover valid and malformed JSON/shapes, flattened field errors, clearing
values, profile/forwarding license plans and expiry, retaining an existing
forward address, retention bounds and old invalid values, timezone preference/
query/header precedence, recurring versus single/explicit-zone/other-user
events, all shared mailbox grants, missing/disabled/personal mailboxes,
signature and automatic-reply text bounds/defaults, and primary/secondary
identity renames. Manual zones isolate the local all-domain flag case; this
capture does not exercise Cloudflare rule-provisioning failures.

`tests/source-auto-reply-contracts.json` records 45 original automatic-reply
function executions with source message/job/contact/audit state, object hashes,
mail-binding payloads and throttle records. Mail and Gravatar are isolated fake
bindings; no real email or external request is used. Cases cover normalized
sender/delivered addresses; missing/bare Message-ID; case-insensitive and padded
suppression headers; list/bulk/no-reply suppression; same-mailbox primary,
normalized and explicit/cross-domain aliases; recent/old deliveries; manual
contacts; primary profile identity; disabled/empty reply settings; subject/body
trimming; exact permitted cross-domain sender spellings; and provider failure.
Native queue payload keys `autoReplyMailboxId` and `autoReplyRecipient` are
excluded explicitly as internal coordination metadata. Dynamic IDs and current
timestamps are normalized. Other source fields remain compared.

```sh
bun scripts/capture-source-preferences.ts /path/to/original-71aa49b
bun scripts/capture-source-auto-reply.ts /path/to/original-71aa49b
bun test tests/source-preferences.test.ts tests/source-auto-reply.test.ts tests/preference-guards.test.ts
bun scripts/smoke-preferences.ts dist/mailrun-local
bun scripts/smoke-auto-reply.ts dist/mailrun-local
```

These are original handler/function comparisons, not complete framework error
framing, cookie/origin or whole-original-ingress evidence.

## Native changes

- Return source flattened preference/mailbox validation errors, timezone errors,
  malformed JSON responses and normalized retention values. Preserve source
  validation-before-permission order for mailbox updates.
- Freeze owned legacy recurring events with NULL timezones under their previous
  effective timezone before setting or clearing the account preference. Keep
  single events, explicit zones, other accounts and event timestamps unchanged.
  Both writes use the same SQLite transaction and current account state.
- Publish profile fields and primary/secondary identity/contact synchronization
  atomically. Recheck forwarding entitlement in the publication transaction.
- Normalize mailbox display names, signatures and automatic-reply text with the
  source field-presence and empty/default rules. Primary mailbox renames use
  full profile synchronization; secondary mailbox identity remains independent.
  Recheck current management grants and return the source detail/error shapes.
- Share the source address-claim rules between identity sync and sender
  authorization. Sending uses exact assigned addresses; receiving retains its
  normalized resolver. Narrow mailboxes load only explicit aliases, and primary
  sending retains its direct fast path. Cross-domain dot/plus spellings that
  merely route to a mailbox are not implicitly added as sending identities.
- Match automatic-reply suppression header lookup, source sender formatting,
  contact updates, reply headers, message/thread fields and queued payloads.
  Keep a waiting/sending job unique per mailbox/recipient across processes.
  Record the 24-hour throttle only after successful delivery. Failed replies
  remain failed in the outbox and permit a new incoming message to trigger a
  fresh attempt.
- Catch automatic-reply queue/authorization failures at the same boundary as
  delivery failures. The original inbound handler catches them after storing
  received mail; a reply failure must not turn successfully stored intake into
  a retryable storage failure.

No persisted table, migration, backup table/group or format changes. UI
components, styles and route templates are unchanged.

## Verification and limits

The compiled preferences rehearsal compares all 171 source cases over real HTTP
and checks profile/contact/mailbox/calendar persistence across restart. The
compiled automatic-reply rehearsal submits 45 signed MIME messages and compares
outgoing message/job fields, provider wire payloads and throttle records to the
reference function outcomes. Each signed request also asserts one retained
incoming message and an existing raw MIME object. Incoming content, intake
contacts and receive audits are outside that particular source-derived outgoing
projection. Direct
function tests separately compare touched contacts, send audits and object
inventory. Additional journeys check provider failure followed by a new-message
retry, delivery by cron with HTTP stopped, and throttling after restarting HTTP.

Five guards verify DST-stable daily instants, rollback of failed timezone/profile
writes, license changes at publication and one queued reply from two independent
Bun processes. The existing mailbox ownership test now expects the captured
404 response instead of the previous internal permission exception.

Initial local checks caught a duplicate SQL query tag and overly broad nullable
join inference; unique named queries and non-null annotations justified by the
inner joins preserve SQLgen/TypeScript checks. New smoke fixtures initially used
a mismatched fake provider Message-ID and an incorrect request origin in their
restart step; both are corrected. Expanded cross-domain cases exposed and fixed
the real automatic-reply intake exception boundary described above.

All 1,631 host tests, generated SQL/coverage and TypeScript pass. The production
build, compiled settings/reply rehearsals and isolated avatar background-job
checks pass. [Native Ubuntu CI 41492133570](https://github.com/ilbertt/mailrun/actions/runs/41492133570)
and independent PR CI 41492144677 both pass all 1,631 tests, SQL/type checks and
every compiled HTTP/WebSocket/parity rehearsal. This includes the 171 settings
cases, 45 signed intake/reply outcomes and all restart/provider/cron journeys.
The selected one-CPU/256-MiB/no-swap rule workload still passes with a
115,724,288-byte cgroup peak and zero OOM kills. It does not establish full
nibrun guest cold/concurrent resource bounds.

Source `aab028f` was deployed on November 2 through the nibrun CLI's
checksum-verified archive fetch to the existing preview. The exact CI binary
was also downloaded privately and verified against its checksum before release.
Executable SHA-256:
`003d5d15ce4a9a67a532d837502e213c402c0adf341a340ce4ebe4681f23aaa0`;
119,363,552 bytes. Archive artifact 13164752823 has digest
`b8acf1a74bc30d7c5ed468db2e6aa0807512e40ff5179d8e7bd6988421028c43`.
Deployment `01a19d58-d80d-75db-845b-1ebeed7d42ba` is running.

Post-release checks confirm public login/setup HTTP 200, one account and five
messages retained, ready installation, active ilbert.dev routing/sending,
email-relay HTTP 200 with a successful signed callback, and all three UTC cron
registrations against this deployment. A status sample reports 46,874,624 bytes
in use; it is not a peak measurement. Release checks used read-only queries and
health requests, with no live email, preference/mailbox mutation, credential
change, restore or reset. The existing approved private recovery export remains
available without another download. Broader
source/provider/client wire and permission matrices, rendered/mobile/keyboard
states, full original-data cutover, successful external interoperability and
whole-guest cold/concurrent resource verification remain open. Existing native
author-only draft access remains pending the owner's permission decision.
Selected matching contracts do not establish full parity.

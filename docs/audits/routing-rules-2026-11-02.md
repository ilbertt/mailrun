# Original routing-rule forms and execution

Mailflare `71aa49b` (v0.5.2) is the reference. Original inbox/domain rule forms
could save data that the native adapter rejected or changed. Native inbox edits
reset preserved metadata, delegated administrators lost their parent-domain
access, domain lists omitted fields/disabled choices, and patch responses and
validation order differed. Rule execution also truncated regex inputs, rejected
valid nested patterns and diverged on forwarding targets, whitespace and ties.

## Original captures

`tests/source-rule-contracts.json` records 204 actual original HTTP responses and
complete persisted rule rows after each request. Source module hashes are pinned.
Cases cover all CRUD methods, known/unknown/shared grants, ordinary owners,
delegated administrators, Team entitlement, disabled/personal mailboxes,
destination ownership, missing rows/folders, schema failures, metadata retention,
long values, regex syntax and valid nested patterns. Only generated identities
and current creation timestamps are normalized. Corrected synthetic fixtures
have unique case names and the same mailbox inventory on both runtimes.

The previous standalone host executable matches 45 cases and fails 159. The
updated host matches all 204, including every saved field. No external mail or
provider resources are used by the capture.

`tests/source-rule-engine.json` adds 59 results from the unmodified original
matcher, domain resolver and inbox selector using their original Node SQLite
adapter. It compares booleans or the relevant action/destination/forward/copy/
reason projection. It covers address normalization, empty/star/fallback values,
all comparison operators, nested/backreference/long/late regex matches, envelope
versus MIME stages, persisted targets, invalid legacy folder references and tied
rules. The orphan-reference fixtures deliberately disable FK enforcement only
while constructing that legacy state; API validation and restore integrity checks
remain enforced. Captures use benign regex inputs; the original is never run on
the pathological deadline test.

```sh
bun scripts/serve-session-fixture.ts --reference /path/to/original-71aa49b \
  --before /path/to/previous-host-binary --after dist/mailrun-local --port 4820
bun scripts/capture-source-rules.ts /path/to/original-71aa49b \
  /path/to/printed/mailrun-test-directory http://127.0.0.1:4820
bun scripts/capture-source-rule-engine.ts /path/to/original-71aa49b \
  /path/to/printed/mailrun-test-directory
bun test tests/source-rules.test.ts tests/source-rule-engine.test.ts \
  tests/routing-regex.test.ts tests/routing.test.ts
bun scripts/smoke-rules.ts dist/mailrun-local
```

## Changes

- Lists retain complete source DTOs, ordering and mailbox disabled flags. Inbox
  creation returns the parsed source fields; edits/delete return `{ok:true}`.
  Schema errors use the source flattened body and validation/authorization order.
- Inbox edits change only the original fields. Creator, scope, name, enabled
  state, creation/match statistics and unrelated metadata survive. Folder
  destinations must belong to the managed inbox. Historical domain-scope rows
  addressed through the inbox route retain the source mailbox-grant behavior.
- Domain access checks the current actor's role, delegation flag and creator
  domain or the explicitly managed mailbox context. Admin and mailbox-context
  destination permissions stay separate. Patch binds the stored domain, returns
  the source response, clears action-inapplicable columns and preserves creator/
  statistics. Body reads occur outside SQLite's queue; grants are rechecked in
  the write transaction. No source table, migration or backup format changes.
- Matching uses the source address normalization, empty-value rules and complete
  input. Domain resolution sees envelope addresses before MIME processing;
  subject/content matching belongs to the later inbox stage, as in the original.
  This removes the native-only domain-body filter behavior. A read-only preview
  preflight found no configured rules affected by that change.
- Forward/reject values are trimmed, a retained copy requires a usable target,
  and persisted legacy targets follow the source's enabled-mailbox lookup. New
  API mutations still enforce the original destination/domain grants. Selection
  drops the native ID tie-break and retains source precedence. Regex execution
  happens after fetching rows, outside serialized SQLite callbacks.

## Bounded regex execution

The heuristic regex rejection and input truncation are replaced by JavaScript
RegExp execution in a short-lived subprocess of the same Bun executable. A
per-process queue bounds concurrent regex processes. A 75 ms computation timer starts
after the child flushes its ready marker; a two-second process deadline also
bounds startup/input transfer. Failure raises `ROUTING_REGEX_LIMIT`, rather than
pretending the rule did not match. Signed intake returns 503 without committing
the failed message. The normal source schema still rejects invalid syntax.

The `regex-match` stdin-only mode runs before migration/HTTP/cron dispatch. The
launcher strips deployment credentials and data-directory configuration and
disables automatic `.env` loading. Message text
uses chunked UTF-16 framing, preserving code units without a full parent JSON
copy; it never enters argv or logs. Syntax/results caches are bounded, and large
inputs are not cached. All regex evaluation is isolated, including patterns a
heuristic might incorrectly classify as safe. The old heuristic package is
removed. [Bun subprocess APIs](https://bun.com/docs/runtime/child-process) provide
the pipe, process deadline and kill mechanism; no Node installation, Worker
service, queue or extra production artifact is needed.

## Verification and limits

All 1,203 host tests, generated SQL/coverage and strict TypeScript pass. The host
standalone check passes the 204 source contracts, signed nested-regex rejection,
match counting, a pathological sender's 503 with no message commit, recovery on
a fresh valid pattern, folder delivery, a four-megabyte restored inbox regex, and
CLI execution without creating its supplied database directory or registering
cron. In the selected host run, an authenticated probe took 4.73 ms while the
deadline request finished in 105.13 ms; these observations are not guest latency
or throughput guarantees. UTF-16 boundary and nonblocking/recovery tests pass.

The exact native Linux executable passes all 1,203 tests, SQL/type checks and
all compiled parity rehearsals in
[Ubuntu CI 41439491975](https://github.com/ilbertt/mailrun/actions/runs/41439491975).
The independent PR run also passes. CI runs the rule check normally and with
one CPU, 256 MiB, no swap, a read-only Debian root filesystem, an unprivileged
UID and 64 MiB temp space. The constrained workload passes all 204 contracts,
signed ingress, deadline/recovery, four-megabyte matching and CLI-mode checks.
Cgroup peak is 115,589,120 bytes (110.23 MiB), with zero OOM kills. Its selected
auth probe is 16.56 ms and deadline request 114.03 ms. This warm container
workload does not prove
the whole nibrun VM's cold peak, concurrent cron/backup/restore load or capacity.
The check now pins the exact tested `debian:bookworm-slim` image digest,
`sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3`.

Source `8ec07a6` was deployed on November 2 through the nibrun CLI's
checksum-verified archive URL path to the existing preview. Executable SHA-256:
`28bc8b7d7a990ac2e66924750b5f3352e5f760a47f3fe4c33db04bab4876cf19`;
archive digest:
`01faf01dc528c238b2e03cf4fc09fffad0ba954c4d48aa078ed53a34b019471a`.
Deployment `01a19c1e-4cfa-7c0b-8016-a655679d47ce` is running. The extracted
nibrun artifact matches the downloaded, verified CI executable. Public
login/setup return 200; read-only checks retain one account, five messages,
zero rules, ready installation and active ilbert.dev routing/sending. The email
relay returns 200 with a successful signed callback, and all three native UTC
cron jobs are registered against this deployment. No live rule/mail mutation,
email send, credential/provider change, restore or reset was used for these
release checks.

Computation deadlines are a native resource boundary, not a claim that every
pathological pattern has the same wall time as the original Worker/runtime.
Broader wire-error/transport, MIME/provider/forward-retry, mobile/rendering,
external-client, full-data cutover and resource gates remain open. The separate
shared-reader draft-body permission choice remains unresolved. This audit does
not establish full parity.

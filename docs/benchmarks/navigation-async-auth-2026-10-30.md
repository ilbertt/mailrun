# Warm navigation with fresh background authentication

The [recorded results](navigation-async-auth-2026-10-30.json) supersede the
blocking-session [d681055 comparison](navigation-session-recheck-2026-10-30.md)
for the current implementation. The updated app now matches the source guard's
warm behavior: render the established layout while checking the current session.
Cold private navigation still uses the bounded bootstrap.

| Production build | Median | p95 |
| --- | ---: | ---: |
| Original `71aa49b`, supported Node/Next | 344.10 ms | 357.00 ms |
| Mailrun `61f57b2`, stale session guard | 36.00 ms | 42.40 ms |
| Updated Mailrun, fresh background session check | 31.00 ms | 36.70 ms |

The old Mailrun build remains an explicitly incorrect parity baseline: its warm
guard does not discover role changes or revoked sessions. The updated build made
20 successful session RPCs during the 20 measured navigations, totaling 7,980
uncompressed bytes. All responses completed before stopping the harness. The
original made 20 `/api/auth/me` requests totaling 9,260 bytes. Neither updated
navigation nor the retained document cache skips the current-session check.

Method: three production builds, clones of the same 10,101-message synthetic
database, macOS arm64/Bun 1.4.4, Node v26.9.0 for the reference, real in-app browser,
100 ms added per HTTP request, no bandwidth throttle. Eleven alternating
Inbox/Sent warmups precede 20 measured clicks. A DOM observer records the matching
visible heading and first row plus two animation frames. All 31 starts per app
have matching completion events; no measured request failed. Individual samples
and binary hashes are in the JSON. Median averages the middle two values; p95 is
nearest rank. Measurements target visible content, not completion of background
authentication; role revocation and timeout semantics have separate browser proofs
in the [authentication audit](../audits/browser-auth-2026-10-30.md).

Reproduce with `scripts/benchmark-navigation.ts`, the pinned original Node/Next
production checkout, a host binary from `61f57b2` and the updated host binary.
Perform 31 ordinary alternating sidebar clicks per app without reloading. Wait
for the final background response, stop the harness and run
`scripts/report-navigation-benchmark.ts`. The run uses only synthetic mail.

This measures warm Inbox/Sent presentation, not the primary original
Vinext/Cloudflare Worker runtime, nibrun cold starts, initial/mobile UI, other flows
or peak/concurrent memory. Those remain separate verification gates.

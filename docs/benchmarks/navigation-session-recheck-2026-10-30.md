# Navigation with current-session validation

Historical build `d681055`. The [fresh background-authentication comparison](navigation-async-auth-2026-10-30.md)
supersedes these figures for the current implementation; the data below is retained.

This [report](navigation-session-recheck-2026-10-30.json) supersedes the earlier
navigation comparison for that implementation. The earlier Mailrun build
reused its session snapshot indefinitely during warm navigation. Original
Mailflare rechecks authentication and roles on pathname changes; the updated
Mailrun guard now does so too. The document locale/branding cache is still reused.

| Production build | Median | p95 |
| --- | ---: | ---: |
| Original `71aa49b`, supported Node/Next runtime | 345.40 ms | 362.50 ms |
| Mailrun `61f57b2`, stale session guard | 39.80 ms | 47.20 ms |
| Updated Mailrun, current session checked | 146.45 ms | 181.20 ms |

The stale-session build is included to make the cost and correctness change
visible. It is not an acceptable parity baseline: browser checks reproduce
incorrect navigation after role changes or session revocation. The earlier
roughly 34 ms result had the same missing behavior and should not be used as the
current app's navigation figure.

This run uses the existing harness and [measurement method](navigation-2026-10-29.md):
three production builds, clones of the same 10,101-message synthetic database,
macOS arm64/Bun 1.4.4 and Node v26.9.0 for the reference, the real in-app browser, 100 ms added per HTTP request,
no bandwidth throttling, 11 warmups followed by 20 measured alternating Inbox/Sent
clicks. An observer measures the matching visible heading/first row plus two
animation frames. Every sample completed and no measured request failed. All timings, including
the current build's 260.7 ms maximum, are retained in the individual results. Median averages the middle two samples; p95 uses nearest rank.

Session replies are explicitly private/no-store, verified through compiled HTTP
and direct RPC requests. The current guard reads authentication, timezone and setup gates in one typed
SQLite snapshot. It made 20 small session server-function requests, totaling 7,320
uncompressed response bytes. It did not refetch document translations/branding.
The original made 20
`/api/auth/me` requests totaling 9,260 bytes in the same measured window.
Current native HTML was 36,215 bytes, including the measurement observer;
the original Node/Next HTML was 24,230 bytes. These are not compressed transport
sizes or cold-start latency measurements.

Reproduce with `scripts/benchmark-navigation.ts`, an original `71aa49b` production
Node/Next checkout, a host binary built from `61f57b2` and a current host binary.
Run 31 normal alternating sidebar clicks per app without reloading, stop the
harness and run `scripts/report-navigation-benchmark.ts`. Binary hashes and
individual samples are recorded in the JSON. The test uses only synthetic data
and emits no external email.

The primary original Vinext/Cloudflare Worker runtime, other flows, initial load,
mobile behavior, nibrun cold starts and concurrent/peak memory remain unverified
performance gates. This result proves only the measured warm Node/Next comparison.

# Browser authentication follow-up

This follows the [session navigation audit](session-navigation-2026-10-30.md).
The reference remains the unmodified `71aa49b` AuthGuard, SHA-256
`109ff16a46af765b2fee27c2acc97ada02df83e1335c4ca1430f3575eadf336d`,
running in its supported Node/Next production mode.

The source checks the cookie first, retries an unauthorized check with the stored
session bearer, limits each probe to five seconds and retains the UI on a
transient failure. Confirmed unauthorized sessions redirect. Existing same-layout
content can render while a new pathname's effect checks the session. Initial
protected HTML is a 200 loading bootstrap, including assistant review pages.

Mailrun now reads cookie and bearer candidates in one generated, typed SQLite
query, with the valid cookie taking precedence. Both the probe and private Start
server functions accept user-session bearers. API-key scopes are unchanged.
The custom same-origin server-function fetch never adds credentials to an
external origin. Probe responses remain private/no-store.

Cold navigation waits for a bounded probe. Warm navigation within an established
layout starts a new probe and renders its cached presentation immediately.
Completed results reapply current roles, setup gates and timezone. Each navigation
has a revision: a superseded result cannot publish an identity, redirect or update
the shared session cache. Preloading does not check or publish authentication.

Transient failure preserves the previous presentation snapshot, marked unverified.
Without a prior identity, presentation uses `user: null` and an unverified cache
scope. Independently authenticated APIs can still load the user's mailbox. No
user or permission is invented. Explicit 401s do not use this transient fallback.
Generation, token and verified-principal guards discard late response effects and
detail content. A private function's late transport hint cannot override the
authoritative probe's credential selection. Bodyless cookie reads may retry once
with the stored session bearer; writes and streams are never replayed.

The disposable browser fixture compared the original, Mailrun `61f57b2` and the
updated production host binary. No real mailbox or role was modified, and no
external email was sent.

| Browser case | Observed result |
| --- | --- |
| Cookie headers and Set-Cookie suppressed; normal sign-in | Original and updated reach Inbox; `61f57b2` returns to Login. |
| Cookies suppressed; hard navigation to `/inbox/message` | Original and updated retain the exact message URL and show the authorized synthetic body. |
| Cookies suppressed; star that message | Updated succeeds with exactly one write request. |
| Cookies suppressed; cold message page with probe HTTP 503 | Updated still loads the authorized body through private APIs with a nullable presentation identity. |
| Warm Inbox to Sent with session probes stalled | Original and updated show Sent without waiting for the deadline. |
| Cold reload while probes stall | Updated loading bootstrap recovers after the bounded probe; this observation is not a precise latency measurement. |
| Probe explicitly returns 401; next private navigation | Updated redirects to Login. |
| Remove primary flag, retaining another primary administrator; open Branding | Updated returns to `/admin`. |
| Remove admin role; open Domains | Updated returns to `/inbox`. |
| Revoke the warmed session; open Sent | Updated redirects to `/login`. |

Use `scripts/serve-session-fixture.ts` as described in the preceding audit.
Additional loopback-only actions are `cookies-off`, `cookies-on`, `probe-503`,
`probe-stall`, `probe-401` and `probe-ok`. These endpoints are absent from the app.
Stop the fixture to release held probes and remove its synthetic databases.

Verification: 440 behavioral tests, generated SQL/coverage, strict TypeScript,
host and Linux x64 compiled HTTP/WebSocket smoke suites, compiled setup/restart
and original queued-job cron checks pass. The Linux-focused auth/probe/cache run
passes 22 tests. Setup smoke assertions now check the source's loading bootstrap;
browser checks establish the subsequent client redirect rather than treating an
SSR redirect as a requirement. No persisted schema or backup table list changes.

The [fresh-session navigation benchmark](../benchmarks/navigation-async-auth-2026-10-30.md)
records all measured background probes. This audit does not prove the full app's
permission/URL matrix, every authentication race, whole-database outage behavior
before HTML can render, mobile parity or the full source-data cutover. Peak memory
under the actual 256 MiB nibrun limit also remains an open gate: the unconstrained
Linux smoke reports a 275 MiB public-send peak, so a successful functional smoke
must not be described as proof that every workload fits that limit.

# Browser regression checks

Run the actual production console against deterministic mock agents:

```sh
npm ci
npx playwright install chromium
npm run build
npm run test:browser
npm run test:browser:report
```

Node 22 or newer is required. `@playwright/test` is pinned to 1.63.0; its matching
Chromium version is installed by the command above. The dependency provides real
browser interaction, EventSource reconnect behavior, downloads, screenshots and
failure traces that the existing Node tests cannot exercise.

The suite owns loopback port 18787, uses one worker, and starts a fresh server
process per test. A busy port fails startup; it never reuses or stops another
server. Teardown signals only its child process. Production modules are loaded
from `dist-server` and the client from `dist`. Build before testing so both reflect
the current source. The fixture passes explicit mock configuration, imports the
mock driver directly, and starts with an empty environment. It does not import the
application entrypoint, load `.env`, read stored credentials or probe providers.
Browser tests cannot select a real provider. Workspace commands remain simulated.

Browser coverage includes:

- Console load, pause/resume, agent selection, directed messages and detail control.
- A complete scripted run reaching the human gate, fresh Snapshot JSON download
  with current run identity, unchanged held state after download, then explicit
  approval reaching Done.
- A real dropped SSE connection, reconnect banner, unavailable Snapshot control,
  fresh snapshot containing a message sent while disconnected, and duplicate event
  frames ignored by the client. Private child-process IPC controls disconnect,
  replay, session expiry/disposal and read-only request/stream counts; there is
  no test-control HTTP route in the application.
- Visible command and Snapshot failures, followed by successful user retry.
- The standalone progress document at desktop (1440 × 1000), mobile (390 × 844)
  and ultrawide (3440 × 968): every item through pagination, view switching,
  filtering/reset, theme control, contained layout and all items in print mode.

- Session login/invalid login/sign-out, protected state and Snapshot, HttpOnly
  Secure `__Host-` cookies, no browser/URL credential persistence, expiry cleanup,
  command/Snapshot 401 cleanup, no unauthenticated SSE churn and recovery after a
  network outage while the session remains valid.
- Keyboard/focus and login light/dark rendering at the same three viewports.
- Console light/dark layouts at 320/390/768/1024/1440/3440px, visibly unobscured
  token labels/values through keyboard and touch, panel/resize focus destinations,
  and contrast measured from actual activity text and focus indicators. Browser-local
  synthetic LIVE/PAUSED/FAILED snapshots prove presentation only; these status cases
  assert no application POSTs and make no provider calls.
- The explicit HTTP loopback session exception and preserved default local mode.

Auth cases select `session-https` or `session` through a fixture option. HTTPS
uses installed OpenSSL to generate a one-day self-signed certificate and synthetic
private key in an owned temporary directory outside Git. The child reads only
those fixture files; teardown removes them. Chromium ignores that fixture's
certificate trust error but performs a real TLS connection and enforces Secure
cookie behavior. This proves loopback browser behavior, not remote TLS,
certificate trust, hosting or deployed acceptance. All operator/session secrets
are synthetic test values. Expiry advances only the injected auth clock over
private IPC; the production session invalidation path closes the stream.

API requests supplement browser assertions with authoritative mock state. They do
not replace the visible control, message, error, download and reconnect checks.
Tests use condition-based waits and no automatic retries; bounded observation
windows prove that failed auth does not cause reconnect churn. Historical runs
and crash recovery coverage is pending their implementation; there are no empty
skipped tests counted as coverage.

## CI evidence

The existing **Runtime checks / validate** job retains its clean installation,
production build, Node tests, Python coordination tests and simulator selfchecks.
It additionally installs Chromium on Linux and runs this suite for PRs targeting
main and pushes to main. Reports are uploaded as **browser-evidence** for 14 days,
including successful login/progress screenshots and failure-only traces/screenshots.
The existing **production-bundle** artifact keeps its seven-day retention.

Artifacts expire and may be deleted earlier by repository policy or a user. Link
the exact run and artifact from the delivery report; an expired artifact is not
current visual evidence. No real credentials or provider data enter these fixtures.
Outputs remain under ignored `runs/browser-report` and `runs/browser-results`.

The harness follows Playwright's [CI guidance](https://playwright.dev/docs/ci) and
[trace retention options](https://playwright.dev/docs/test-use-options).

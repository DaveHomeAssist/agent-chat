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
browser interaction, native EventSource reconnection, downloads, screenshots and
failure traces that the existing Node tests cannot exercise.

The suite owns loopback port 18787, uses one worker, and starts a fresh server
process per test. A busy port fails startup; it never reuses or stops another
server. Teardown signals only its child process. Production modules are loaded
from `dist-server` and the client from `dist`. Build before testing so both reflect
the current source. The fixture passes explicit mock configuration, imports the
mock driver directly, and starts with an empty environment. It does not import the
application entrypoint, load `.env`, read stored credentials or probe providers.
Browser tests cannot select a real provider. Workspace commands remain simulated.

Seven tests cover:

- Console load, pause/resume, agent selection, directed messages and detail control.
- A complete scripted run reaching the human gate, fresh Snapshot JSON download
  with current run identity, unchanged held state after download, then explicit
  approval reaching Done.
- A real dropped SSE connection, reconnect banner, unavailable Snapshot control,
  fresh snapshot containing a message sent while disconnected, and duplicate event
  frames ignored by the client. Private child-process IPC controls only disconnect
  and replay; there is no test-control HTTP route in the application.
- Visible command and Snapshot failures, followed by successful user retry.
- The standalone progress document at desktop (1440 × 1000), mobile (390 × 844)
  and ultrawide (3440 × 968): every item through pagination, view switching,
  filtering/reset, theme control, contained layout and all items in print mode.

API requests supplement browser assertions with authoritative mock state. They do
not replace the visible control, message, error, download and reconnect checks.
Tests use condition-based waits and no automatic retries. Future authentication,
historical runs and crash recovery coverage is pending their implementation; there
are no empty skipped tests counted as coverage.

## CI evidence

The existing **Runtime checks / validate** job retains its clean installation,
production build, Node tests, Python coordination tests and simulator selfchecks.
It additionally installs Chromium on Linux and runs this suite for PRs targeting
main and pushes to main. Reports are uploaded as **browser-evidence** for 14 days,
including successful progress screenshots and failure-only traces/screenshots.
The existing **production-bundle** artifact keeps its seven-day retention.

Artifacts expire and may be deleted earlier by repository policy or a user. Link
the exact run and artifact from the delivery report; an expired artifact is not
current visual evidence. No real credentials or provider data enter these fixtures.
Outputs remain under ignored `runs/browser-report` and `runs/browser-results`.

The harness follows Playwright's [CI guidance](https://playwright.dev/docs/ci) and
[trace retention options](https://playwright.dev/docs/test-use-options).

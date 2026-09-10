import type { Page } from '@playwright/test'
import type { RunSnapshot } from '../../shared/protocol.js'
import { test, expect, OPERATOR_TOKEN } from './fixtures.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
async function pausedRun(page: Page) {
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await page.getByRole('button', { name: 'Pause run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeEnabled()
}
async function screenshot(page: Page, output: (name: string) => string, name: string) {
  await page.screenshot({ path: output(name + '.png'), fullPage: true })
  for (const selector of ['.ac-input', '.ac-target', '.ac-actions button:not(:disabled)']) {
    for (const element of await page.locator(selector).all()) {
      if (!await element.isVisible()) continue
      expect(await element.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && !!top && (node === top || node.contains(top))
      })).toBe(true)
    }
  }
}

test('real held acceptance excludes duplicate sends, preserves every newer edit and keeps safe controls usable', async ({ page }, info) => {
  await page.goto('/'); await pausedRun(page)
  const input = page.getByRole('textbox', { name: 'Message the room' })
  let posts = 0
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/message') posts++ })
  const edits = ['typing', 'edit-revert', 'target', 'quick-command', 'detail-message'] as const
  for (const [index, edit] of edits.entries()) {
    const held = barrier(), fetched = barrier()
    let serverStatus = 0
    await page.route('**/api/message', async (route) => {
      const response = await route.fetch()
      serverStatus = response.status()
      fetched.release()
      await held.promise
      await route.fulfill({ response })
    })
    const raw = `  Paid attention to draft version ${index}  `
    await input.fill(raw)
    await input.evaluate((node) => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await fetched.promise
    expect(serverStatus).toBe(200)
    await expect(page.getByText('Message: Sending…', { exact: true })).toBeVisible()
    expect(posts).toBe(index + 1)
    await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Approve before merge', exact: true })).toBeDisabled()
    await expect(input).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
    if (edit === 'typing') await input.fill('New unsent instruction')
    if (edit === 'edit-revert') { await input.fill('Temporary edit'); await input.fill(raw) }
    if (edit === 'target') await page.locator('.ac-target').click()
    if (edit === 'quick-command') await page.locator('.ac-quick-btn:not(:disabled)').first().click()
    if (edit === 'detail-message') await page.getByRole('button', { name: 'Message', exact: true }).click()
    const retained = await input.inputValue()
    if (edit === 'typing') {
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Snapshot', exact: true }).click()
      expect((await download).suggestedFilename()).toMatch(/\.json$/)
      await screenshot(page, (name) => info.outputPath(name), 'desktop-light-pending')
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
      await screenshot(page, (name) => info.outputPath(name), 'desktop-dark-pending')
      // A newer allowed interrupt owns this real server rejection banner.
      await page.getByRole('button', { name: 'Interrupt', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('agent has no active operation')
      await screenshot(page, (name) => info.outputPath(name), 'desktop-dark-pending-error')
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
      await screenshot(page, (name) => info.outputPath(name), 'desktop-light-pending-error')
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Room', exact: true }).click()
      await screenshot(page, (name) => info.outputPath(name), 'phone-light-pending-error')
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
      await screenshot(page, (name) => info.outputPath(name), 'phone-dark-pending-error')
      await page.setViewportSize({ width: 1440, height: 1000 })
    }
    held.release()
    await expect(page.getByText('Message: Sending…', { exact: true })).toHaveCount(0)
    await expect(input).toHaveValue(retained)
    if (edit === 'typing') await expect(page.getByRole('alert')).toContainText('agent has no active operation')
    const state = await (await page.request.get('/api/state')).json() as RunSnapshot
    expect(state.thread.filter((item) => item.kind === 'human' && item.body === raw.trim())).toHaveLength(1)
    await page.unroute('**/api/message')
  }
  expect(posts).toBe(edits.length)
})

test('malformed and non-success HTTP acknowledgements retain draft and never start a repair read', async ({ page, mockServer }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toBeEnabled()
  const before = await mockServer.command('stats')
  const input = page.getByRole('textbox', { name: 'Message the room' })
  const cases = [
    { status: 200, body: '{' }, { status: 200, body: '1' },
    { status: 200, body: '{"ok":true}' }, { status: 200, body: '{"ok":true,"seq":1e400}' },
    { status: 200, body: '{"ok":false,"error":42}' },
    { status: 503, body: '{"ok":true,"seq":0}' }, { status: 409, body: '{"ok":false,"error":"Deliberate refusal"}' },
  ]
  let count = 0
  for (const response of cases) {
    await page.route('**/api/message', async (route) => { count++; await route.fulfill({ ...response, contentType: 'application/json' }) })
    await input.fill('Preserve this draft')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(input).toHaveValue('Preserve this draft')
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await page.unroute('**/api/message')
  }
  expect(count).toBe(cases.length)
  expect((await mockServer.command('stats')).stateRequests).toBe(before.stateRequests)
  // Synthetic response handling above is not server-effect evidence.
})

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`lost control state reaches bounded refresh and preserves drafts at ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    const initial = await (await page.request.get('/api/state')).json() as RunSnapshot
    initial.seq = 9; initial.run.approvalGate = false; initial.run.status = 'live'
    await page.clock.install()
    await page.addInitScript((full) => {
      type Source = EventTarget & { onopen: (() => void) | null; close(): void }
      const sources: Source[] = []
      class ControlledSource extends EventTarget {
        onopen: (() => void) | null = null
        onerror: (() => void) | null = null
        constructor() {
          super(); sources.push(this)
          if (sources.length === 1) queueMicrotask(() => {
            this.onopen?.()
            this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify({ type: 'snapshot', seq: full.seq, snapshot: full }) }))
          })
        }
        close() {}
      }
      Object.assign(window, {
        EventSource: ControlledSource,
        commandTestEmit: (event: { type: string }, index = sources.length - 1) => sources[index].dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })),
        commandTestOpen: () => sources.at(-1)?.onopen?.(),
        commandTestSources: () => sources.length,
      })
    }, initial)
    const held = barrier(), started = barrier()
    let reads = 0, posts = 0
    page.on('request', (request) => { if (request.method() === 'POST') posts++ })
    await page.route('**/api/state', async (route) => { reads++; started.release(); await held.promise; await route.abort().catch(() => {}) })
    await page.goto('/')
    const input = page.getByRole('textbox', { name: 'Message the room' })
    await expect(page.getByRole('button', { name: 'Pause run', exact: true })).toBeEnabled()
    await input.fill('Retain this while state is repaired')
    await page.evaluate((stats) => {
      (window as unknown as { commandTestEmit(event: unknown): void }).commandTestEmit({ type: 'stats', seq: 11, stats })
    }, initial.stats)
    await started.promise
    await expect(page.getByText('Waiting for current run state', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pause run', exact: true })).toBeDisabled()
    await page.clock.runFor(15_000)
    await expect(page.getByText('State needs refresh', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Refresh state', exact: true })).toBeEnabled()
    await screenshot(page, (name) => info.outputPath(name), `${viewport.width}-light-refresh-draft`)
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
    await screenshot(page, (name) => info.outputPath(name), `${viewport.width}-dark-refresh-draft`)
    if (viewport.width === 1440) {
      const refresh = page.getByRole('button', { name: 'Refresh state', exact: true })
      for (const theme of ['dark', 'light'] as const) {
        if (theme === 'light') await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
        await page.getByRole('button', { name: 'Snapshot', exact: true }).focus()
        await refresh.focus()
        await expect(refresh).toBeFocused()
        await page.setViewportSize({ width: 1024, height: 768 })
        await page.clock.runFor(50)
        await screenshot(page, (name) => info.outputPath(name), `correction-012-${theme}-compact-refresh-focus`)
        await expect(refresh).toBeVisible()
        await expect(refresh).toBeFocused()
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.clock.runFor(50)
        await expect(refresh).toBeVisible()
        await expect(refresh).toBeFocused()
      }
    }
    let failedProbes = 0
    await page.route('**/api/auth/status', async (route) => { failedProbes++; await route.fulfill({ status: 503, body: '{}' }) })
    await page.getByRole('button', { name: 'Refresh state', exact: true }).click()
    await expect.poll(() => failedProbes).toBe(1)
    await expect(page.getByRole('button', { name: 'Refresh state', exact: true })).toBeEnabled()
    await page.clock.runFor(20_000)
    expect(failedProbes).toBe(1)
    await expect(page.getByText('● reconnecting to run server…', { exact: true })).toHaveCount(0)
    await page.unroute('**/api/auth/status')
    await page.getByRole('button', { name: 'Refresh state', exact: true }).evaluate((node) => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click() })
    await expect.poll(() => page.evaluate(() => (window as unknown as { commandTestSources(): number }).commandTestSources())).toBe(2)
    await page.evaluate(() => (window as unknown as { commandTestOpen(): void }).commandTestOpen())
    await expect(page.getByRole('button', { name: 'Pause run', exact: true })).toBeDisabled()
    await page.evaluate((snapshot) => {
      (window as unknown as { commandTestEmit(event: unknown): void }).commandTestEmit({ type: 'snapshot', seq: snapshot.seq, snapshot })
    }, { ...initial, seq: 1, run: { ...initial.run, id: 'new-server-run', status: 'paused', approvalGate: true } })
    await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeEnabled()
    await expect(input).toHaveValue('Retain this while state is repaired')
    await expect(page.getByText('State needs refresh', { exact: true })).toHaveCount(0)
    expect(reads).toBe(1); expect(posts).toBe(0)
    held.release()
  })
}

test.describe('pending auth privacy', () => {
  test.use({ authMode: 'session' })
  test('sign out remains usable during held command acceptance and discards the old session draft', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Operator key', { exact: true }).fill(OPERATOR_TOKEN)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await pausedRun(page)
    const held = barrier(), fetched = barrier()
    await page.route('**/api/message', async (route) => {
      const response = await route.fetch(); fetched.release(); await held.promise
      await route.fulfill({ response }).catch(() => {})
    })
    await page.getByRole('textbox', { name: 'Message the room' }).fill('Discard at the privacy boundary')
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await fetched.promise
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.getByLabel('Operator key', { exact: true })).toBeVisible()
    held.release()
    await page.getByLabel('Operator key', { exact: true }).fill(OPERATOR_TOKEN)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message the room' })).toHaveValue('')
    await expect(page.locator('.ac-command-pending')).toHaveCount(0)
  })
})

for (const mode of ['composition', 'repeat', 'shift'] as const) {
  test(`correction 012 ${mode} Enter preserves the draft without a POST before deliberate Enter`, async ({ page }, info) => {
    await page.goto('/'); await pausedRun(page)
    const input = page.getByRole('textbox', { name: 'Message the room' })
    const raw = `  Retain the ${mode} draft  `
    await input.fill(raw)
    let posts = 0
    page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/message') posts++ })
    const posted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/message')
    const prevented = await input.evaluate((node, mode) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: mode === 'composition', repeat: mode === 'repeat', shiftKey: mode === 'shift' })
      node.dispatchEvent(event)
      return event.defaultPrevented
    }, mode)
    // Capture the old handler's actual accepted effect before its expected failure.
    if (prevented) await posted
    const afterIgnored = await (await page.request.get('/api/state')).json() as RunSnapshot
    const evidence = { mode, prevented, posts, draft: await input.inputValue(), matchingHumanMessages: afterIgnored.thread.filter((item) => item.kind === 'human' && item.body === raw.trim()).length }
    await info.attach('ignored-enter-result.json', { body: JSON.stringify(evidence), contentType: 'application/json' })
    expect(evidence).toEqual({ mode, prevented: false, posts: 0, draft: raw, matchingHumanMessages: 0 })
    if (mode === 'composition') await screenshot(page, (name) => info.outputPath(name), 'correction-012-composition-draft-retained')
    await input.press('Enter')
    expect((await posted).status()).toBe(200)
    await expect(input).toHaveValue('')
    expect(posts).toBe(1)
    const afterAccepted = await (await page.request.get('/api/state')).json() as RunSnapshot
    expect(afterAccepted.thread.filter((item) => item.kind === 'human' && item.body === raw.trim())).toHaveLength(1)
  })
}

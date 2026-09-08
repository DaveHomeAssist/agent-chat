/// <reference lib="dom" />
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { test, expect, OPERATOR_TOKEN } from './fixtures.js'

async function login(page: Page) {
  await page.getByLabel('Operator key', { exact: true }).fill(OPERATOR_TOKEN)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
}

async function loggedOut(page: Page) {
  await expect(page.getByRole('heading', { name: 'Sign in to your console', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message the room' })).toHaveCount(0)
  await expect(page.getByLabel('Operator key', { exact: true })).toHaveValue('')
}

test.describe('session authentication over loopback HTTPS', () => {
  test.use({ authMode: 'session-https' })

  test('gates console and SSE, rejects bad login, uses an HttpOnly Secure cookie, exports safely and logs out', async ({ page, context, mockServer }) => {
    const urls: string[] = []
    page.on('request', (request) => urls.push(request.url()))
    await page.goto('/')
    await loggedOut(page)
    expect(await mockServer.command('stats')).toMatchObject({ eventRequests: 0, stateRequests: 0, activeStreams: 0 })
    expect((await page.request.get('/api/state')).status()).toBe(401)
    expect((await page.request.get('/api/events')).status()).toBe(401)
    const key = page.getByLabel('Operator key', { exact: true })
    await key.fill('invalid-synthetic-operator-key')
    await key.press('Enter')
    await expect(page.getByRole('alert')).toContainText('not accepted')
    await expect(key).toHaveValue('')
    await expect(key).toBeFocused()
    await login(page)
    const cookies = await context.cookies()
    const session = cookies.find((cookie) => cookie.name === '__Host-agent_chat_session')
    expect(session).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' })
    expect(session!.expires * 1000 - Date.now()).toBeGreaterThan(28_000_000)
    const browserStorage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }))
    expect(JSON.stringify(browserStorage)).not.toContain(OPERATOR_TOKEN)
    expect(JSON.stringify(browserStorage)).not.toContain(session!.value)
    expect(browserStorage.cookies).not.toContain('__Host-agent_chat_session')
    const snapshot = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Snapshot', exact: true }).click()
    const file = await (await snapshot).path()
    const exported = await readFile(file!, 'utf8')
    expect(JSON.parse(exported).snapshot.run.llm).toBe('mock')
    expect(exported).not.toContain(OPERATOR_TOKEN)
    expect(exported).not.toContain(session!.value)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await loggedOut(page)
    await expect(page.getByRole('status')).toContainText('Signed out')
    expect((await context.cookies()).some((cookie) => cookie.name === '__Host-agent_chat_session')).toBe(false)
    await expect.poll(async () => (await mockServer.command('stats')).activeStreams).toBe(0)
    expect((await page.request.get('/api/state')).status()).toBe(401)
    expect(urls.join('\n')).not.toContain(OPERATOR_TOKEN)
    expect(urls.join('\n')).not.toContain(session!.value)
    await login(page)
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
  })

  test('expiry removes the old run and stops unauthenticated SSE churn', async ({ page, mockServer }) => {
    await page.goto('/')
    await login(page)
    await page.getByRole('button', { name: 'Start run', exact: true }).click()
    await page.getByRole('button', { name: 'Pause run', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible()
    const body = 'Private run content must disappear on expiry.'
    await page.getByRole('textbox', { name: 'Message the room' }).fill(body)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText(body, { exact: true })).toBeVisible()
    await mockServer.command('expire')
    await loggedOut(page)
    await expect(page.getByRole('status')).toContainText('session ended')
    await expect(page.getByText(body, { exact: true })).toHaveCount(0)
    const after = await mockServer.command('stats')
    expect(after.activeStreams).toBe(0)
    // Longer than the initial reconnect delay: confirmed loss must stop attempts.
    await page.waitForTimeout(2500)
    expect((await mockServer.command('stats')).eventRequests).toBe(after.eventRequests)
    expect((await page.request.get('/api/state')).status()).toBe(401)
    await login(page)
  })

  test('an ordinary stream outage probes the valid session and recovers with fresh state', async ({ page, mockServer }) => {
    await page.goto('/')
    await login(page)
    await page.getByRole('button', { name: 'Start run', exact: true }).click()
    await page.getByRole('button', { name: 'Pause run', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible()
    await mockServer.command('disconnect')
    await expect(page.getByRole('status')).toContainText('reconnecting')
    await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeDisabled()
    const posted = await page.evaluate(async () => {
      const response = await fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Fresh state after authenticated reconnect.', target: 'all' }) })
      return response.status
    })
    expect(posted).toBe(200)
    await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
    await expect(page.getByText('Fresh state after authenticated reconnect.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
    expect((await mockServer.command('stats')).eventRequests).toBeGreaterThan(1)
  })

  for (const action of ['Snapshot', 'Start run']) {
    test(`${action} 401 clears the mounted console without retrying login`, async ({ page, context, mockServer }) => {
      await page.goto('/')
      await login(page)
      await context.clearCookies()
      await page.getByRole('button', { name: action, exact: true }).click()
      await loggedOut(page)
      await expect.poll(async () => (await mockServer.command('stats')).activeStreams).toBe(0)
      const after = await mockServer.command('stats')
      await page.waitForTimeout(2500)
      expect((await mockServer.command('stats')).eventRequests).toBe(after.eventRequests)
    })
  }

  test('network failure during an auth probe does not discard a still-valid session or reopen SSE early', async ({ page, mockServer }) => {
    await page.goto('/')
    await login(page)
    await page.route('**/api/auth/status', (route) => route.abort('internetdisconnected'))
    const before = await mockServer.command('stats')
    await mockServer.command('disconnect')
    await expect(page.getByRole('status')).toContainText('reconnecting')
    await page.waitForTimeout(2500)
    expect((await mockServer.command('stats')).eventRequests).toBe(before.eventRequests)
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
    await page.unroute('**/api/auth/status')
    await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
  })

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'ultrawide', width: 3440, height: 968 },
  ]) {
    test(`login renders with keyboard access in light and dark at ${viewport.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      await page.goto('/')
      await loggedOut(page)
      await expect(page.getByLabel('Operator key', { exact: true })).toBeFocused()
      for (const theme of ['light', 'dark']) {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await testInfo.attach(`login-${viewport.name}-${theme}`, { body: await page.screenshot({ fullPage: true, path: testInfo.outputPath(`login-${viewport.name}-${theme}.png`) }), contentType: 'image/png' })
        await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
      }
    })
  }
})

test.describe('explicit HTTP loopback session exception', () => {
  test.use({ authMode: 'session' })
  test('session flow uses the loopback cookie while preserving authentication', async ({ page, context }) => {
    await page.goto('/')
    await loggedOut(page)
    await login(page)
    expect((await context.cookies()).find((cookie) => cookie.name === 'agent_chat_session')).toMatchObject({ secure: false, httpOnly: true, sameSite: 'Strict' })
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await loggedOut(page)
  })
})

import type { Page, TestInfo } from '@playwright/test'
import { deriveAgentActivity } from '../../src/lib/activity.js'
import type { AgentId, RunSnapshot } from '../../shared/protocol.js'
import { test, expect } from './fixtures.js'

async function state(page: Page): Promise<RunSnapshot> {
  const response = await page.request.get('/api/state')
  expect(response.ok()).toBeTruthy()
  return await response.json() as RunSnapshot
}

async function openConsole(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
}

async function selectAgent(page: Page, id: AgentId) {
  const agentsPanel = page.getByRole('button', { name: 'Agents', exact: true })
  if (await agentsPanel.isVisible()) await agentsPanel.click()
  await page.locator('.ac-agent-row').filter({ hasText: new RegExp(id, 'i') }).click()
}

async function openAgentOutput(page: Page) {
  await page.getByRole('button', { name: 'Output log', exact: true }).click()
  return page.locator('.ac-log-foot')
}

test('console reports representative activity and makes unfinished controls explicitly unavailable', async ({ page, mockServer }) => {
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname)
  })
  await openConsole(page)
  const initial = await state(page)
  await selectAgent(page, 'forge')

  const reassign = page.getByRole('button', { name: 'Reassign', exact: true })
  await expect(reassign).toBeDisabled()
  await expect(page.getByText('Reassign unavailable · Task transfer is not implemented.', { exact: true })).toBeVisible()
  await reassign.evaluate((button) => (button as HTMLButtonElement).click())
  await expect(page.getByText('Tool approval contract not implemented.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Auto-approve tool calls/i })).toHaveCount(0)
  expect(posts).toEqual([])

  const currentPr = initial.pipeline.pr.trim().replace(/^PR\s+/i, '')
  await expect(page.getByRole('button', { name: `/approve merge ${currentPr}`, exact: true })).toBeEnabled()

  const footer = await openAgentOutput(page)
  await expect(footer).toHaveText('Idle')
  await expect(footer).toHaveAttribute('data-animated', 'false')
  await expect(footer).toHaveAttribute('aria-live', 'polite')
  await expect(footer).toHaveAttribute('aria-atomic', 'true')
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause run', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pause run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible()
  await expect(footer).toHaveText(/^(Paused|Pausing · current operation finishing)$/)
  await expect(footer).not.toContainText('streaming')

  await mockServer.command('disconnect')
  await expect(footer).toHaveText('Disconnected · reconnecting')
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Resume run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Approve merge', exact: true })).toBeVisible()
  const held = await state(page)
  const selected = held.agents.find((candidate) => candidate.id === 'forge')!
  const expected = deriveAgentActivity('live', held.run, selected, held.typing)
  await expect(footer).toHaveText(expected.label)
  await expect(footer).not.toContainText('streaming')
})

test('token disclosure preserves counters and works with keyboard and pointer input', async ({ page }) => {
  await openConsole(page)
  const snapshot = await state(page)
  const disclosure = page.locator('.ac-token-disclosure')
  const summary = disclosure.locator('summary')
  const expected = [
    `Input${snapshot.stats.inputTokens.toLocaleString('en-US')}`,
    `Output${snapshot.stats.outputTokens.toLocaleString('en-US')}`,
    `Cache read${snapshot.stats.cacheReadTokens.toLocaleString('en-US')}`,
    `Cache write${snapshot.stats.cacheWriteTokens.toLocaleString('en-US')}`,
  ]

  await summary.focus()
  await expect(summary).toBeFocused()
  expect(await summary.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid')
  await summary.press('Enter')
  await expect(disclosure).toHaveAttribute('open', '')
  await expect(disclosure.locator('dl > div')).toHaveText(expected)
  await summary.press('Enter')
  await expect(disclosure).not.toHaveAttribute('open', '')
  await summary.click()
  await expect(disclosure).toHaveAttribute('open', '')
})

test.describe('touch disclosure', () => {
  test.use({ hasTouch: true })

  test('token disclosure opens with a tap', async ({ page }) => {
    await openConsole(page)
    const disclosure = page.locator('.ac-token-disclosure')
    await disclosure.locator('summary').tap()
    await expect(disclosure).toHaveAttribute('open', '')
  })
})

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'ultrawide', width: 3440, height: 968 },
]) {
  test(`truthful controls render under reduced motion at ${viewport.name}`, async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openConsole(page)
    await selectAgent(page, 'forge')
    await expect(page.getByRole('button', { name: 'Reassign', exact: true })).toBeDisabled()
    const agentsPanel = page.getByRole('button', { name: 'Agents', exact: true })
    if (await agentsPanel.isVisible()) {
      await agentsPanel.click()
      await expect(page.getByText('Unavailable', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Context', exact: true }).click()
    } else {
      await expect(page.getByText('Unavailable', { exact: true })).toBeVisible()
    }
    const tokenSummary = page.locator('.ac-token-disclosure summary')
    await expect(tokenSummary).toBeVisible()
    await tokenSummary.click()
    await testInfo.attach(`controls-${viewport.name}-subtask`, {
      body: await page.screenshot({ fullPage: true, path: testInfo.outputPath(`controls-${viewport.name}-subtask.png`) }),
      contentType: 'image/png',
    })
    await tokenSummary.click()
    const footer = await openAgentOutput(page)
    expect(await footer.locator('.ac-cursor').evaluate((cursor) => getComputedStyle(cursor).animationName)).toBe('none')
    await testInfo.attach(`controls-${viewport.name}-activity`, {
      body: await page.screenshot({ fullPage: true, path: testInfo.outputPath(`controls-${viewport.name}-activity.png`) }),
      contentType: 'image/png',
    })
  })
}

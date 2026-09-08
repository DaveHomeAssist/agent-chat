import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures.js'
import type { RunSnapshot } from '../../shared/protocol.js'

async function state(page: Page): Promise<RunSnapshot> {
  const response = await page.request.get('/api/state')
  expect(response.ok()).toBeTruthy()
  const snapshot = await response.json() as RunSnapshot
  expect(snapshot.run.llm).toBe('mock')
  return snapshot
}

async function openConsole(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
  await expect(page.getByRole('status')).toContainText('the scripted mock')
  expect((await state(page)).run.status).toBe('idle')
}

test('console controls pause, resume, select an agent and send a message', async ({ page }) => {
  await openConsole(page)
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await page.getByRole('button', { name: 'Pause run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible()
  expect((await state(page)).run.status).toBe('paused')
  await page.getByRole('button', { name: /FG Forge/ }).click()
  await page.getByRole('button', { name: 'Message', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Message the room' })
  await expect(composer).toHaveValue('@Forge ')
  await composer.fill('Browser regression: keep this paused message visible.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(composer).toHaveValue('')
  await expect(page.getByText('Browser regression: keep this paused message visible.', { exact: true })).toHaveCount(1)
  expect((await state(page)).thread.some((item) => item.kind === 'human' && item.target === 'forge')).toBeTruthy()
  await page.getByRole('button', { name: 'Hide detail', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Agent detail', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resume run', exact: true }).click()
  await expect.poll(async () => (await state(page)).run.status).not.toBe('paused')
})

test('mock run holds approval, Snapshot downloads fresh current-run JSON, approval releases it', async ({ page }) => {
  await openConsole(page)
  const initialId = (await state(page)).run.id
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Approve merge', exact: true })).toBeVisible()
  const held = await state(page)
  expect(held.run.status).toBe('needs_approval')
  expect(held.run.id).not.toBe(initialId)
  expect(held.run.approvalGate).toBe(true)
  expect(held.stats.toolCalls).toBeGreaterThan(0)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Snapshot', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^agent-chatroom-.+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/)
  expect(download.suggestedFilename()).toContain(held.run.id)
  const file = await download.path()
  expect(file).not.toBeNull()
  const exported = JSON.parse(await readFile(file!, 'utf8'))
  expect(Object.keys(exported).sort()).toEqual(['exportedAt', 'formatVersion', 'snapshot'])
  expect(exported.formatVersion).toBe(1)
  expect(Number.isFinite(Date.parse(exported.exportedAt))).toBeTruthy()
  expect(exported.snapshot.run.id).toBe(held.run.id)
  expect(exported.snapshot.run.status).toBe('needs_approval')
  expect(exported.snapshot.seq).toBeGreaterThanOrEqual(held.seq)
  expect(Object.keys(exported.snapshot).sort()).toEqual(['agents', 'pipeline', 'run', 'seq', 'stats', 'thread', 'typing'])
  expect((await state(page)).run.status).toBe('needs_approval')
  await page.getByRole('button', { name: 'Approve merge', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restart run', exact: true })).toBeVisible()
  expect((await state(page)).run.status).toBe('done')
})

test('dropped SSE reconnects with fresh state and ignores replayed thread frames', async ({ page, mockServer }) => {
  await openConsole(page)
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await page.getByRole('button', { name: 'Pause run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible()
  await mockServer.command('disconnect')
  await expect(page.getByRole('status').filter({ hasText: 'reconnecting to run server' })).toContainText('reconnecting')
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeDisabled()
  const body = 'Message created while the stream was disconnected.'
  const response = await page.request.post('/api/message', { data: { body, target: 'all' } })
  expect(response.ok()).toBeTruthy()
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
  await expect(page.getByText(body, { exact: true })).toHaveCount(1)
  expect((await mockServer.command('replay')).replayedBody).toBe(body)
  // A fresh command is an ordering barrier: its event follows both replay frames.
  await page.getByRole('textbox', { name: 'Message the room' }).fill('After replay ordering barrier.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('After replay ordering barrier.', { exact: true })).toBeVisible()
  await expect(page.getByText(body, { exact: true })).toHaveCount(1)
  expect((await state(page)).thread.filter((item) => item.body === body)).toHaveLength(1)
})

test('command and Snapshot failures stay visible and recover after retry', async ({ page }) => {
  await openConsole(page)
  await page.route('**/api/run/start', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Fixture service unavailable' }),
  }))
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Fixture service unavailable')
  await page.unroute('**/api/run/start')
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.route('**/api/state', (route) => route.fulfill({ status: 503, body: 'Unavailable' }))
  await page.getByRole('button', { name: 'Snapshot', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Snapshot failed: 503')
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
  await page.unroute('**/api/state')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Snapshot', exact: true }).click()
  await download
  await expect(page.getByRole('alert')).toHaveCount(0)
})

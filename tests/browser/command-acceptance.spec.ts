import { test, expect } from './fixtures.js'
import type { RunSnapshot } from '../../shared/protocol.js'

test('rejected Message preserves the draft and shows the server error without posting or retrying', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
  const before = await (await page.request.get('/api/state')).json() as RunSnapshot
  expect(before.run.status).toBe('idle')
  const composer = page.getByRole('textbox', { name: 'Message the room' })
  const draft = '  Keep this original draft until a run can accept it.  '
  await composer.fill(draft)
  let submissions = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/message' && request.method() === 'POST') submissions++
  })
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/message')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  expect((await rejected).status()).toBe(409)
  await expect(page.getByRole('alert')).toContainText('run is not active')
  await expect(composer).toHaveValue(draft)
  expect(await (await page.request.get('/api/state')).json()).toEqual(before)
  await page.waitForTimeout(1100)
  expect(submissions).toBe(1)
  await expect(composer).toHaveValue(draft)
  await testInfo.attach('rejected-message-draft', { body: await page.screenshot({ fullPage: true, path: testInfo.outputPath('rejected-message-draft.png') }), contentType: 'image/png' })

  // Only a new human submission after starting a run may clear the retained draft.
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await page.getByRole('button', { name: 'Pause run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible()
  await expect(composer).toHaveValue(draft)
  expect(submissions).toBe(1)
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/message')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  expect((await accepted).status()).toBe(200)
  await expect(composer).toHaveValue('')
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(submissions).toBe(2)
  const after = await (await page.request.get('/api/state')).json() as RunSnapshot
  expect(after.thread.filter((item) => item.kind === 'human' && item.body === draft.trim())).toHaveLength(1)
})

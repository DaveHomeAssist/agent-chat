import type { Page, TestInfo } from '@playwright/test'
import { OPERATOR_TOKEN, expect, test } from './fixtures.js'

async function openConsole(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
  await expect(page.locator('.ac-app')).toHaveAttribute('data-theme', 'light')
}

async function expectNoPageOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(widths.documentWidth).toBeLessThanOrEqual(widths.viewportWidth)
  expect(widths.bodyWidth).toBeLessThanOrEqual(widths.viewportWidth)
}

async function attachConsole(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}.png`) }),
    contentType: 'image/png',
  })
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-320', width: 320, height: 720 },
  { name: 'ultrawide', width: 3440, height: 968 },
]) {
  test(`console remains usable in both themes at ${viewport.name}`, async ({ page, mockServer }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openConsole(page)

    const app = page.locator('.ac-app')
    const theme = page.getByRole('button', { name: 'Dark mode', exact: true })
    const composer = page.getByRole('textbox', { name: 'Message the room' })
    const mobile = viewport.width <= 760

    await expect(theme).toHaveAttribute('aria-pressed', 'false')
    await theme.focus()
    await expect(theme).toBeFocused()
    expect(await theme.evaluate((button) => getComputedStyle(button).outlineStyle)).toBe('solid')
    await expectNoPageOverflow(page)

    if (mobile) {
      const room = page.getByRole('button', { name: 'Room', exact: true })
      const agents = page.getByRole('button', { name: 'Agents', exact: true })
      const context = page.getByRole('button', { name: 'Context', exact: true })

      await expect(room).toHaveAttribute('aria-current', 'page')
      await expect(composer).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start run', exact: true })).toBeVisible()
      await expect(page.locator('.ac-token-disclosure summary')).toBeVisible()
      await attachConsole(page, testInfo, `${viewport.name}-light-room`)

      await agents.click()
      await expect(agents).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('.ac-sidebar')).toBeVisible()
      await expect(page.getByText('Tool approval contract not implemented.', { exact: true })).toBeVisible()
      await expectNoPageOverflow(page)
      await attachConsole(page, testInfo, `${viewport.name}-light-agents`)

      await page.locator('.ac-agent-row').filter({ hasText: /Forge/i }).click()
      await expect(context).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('.ac-detail')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Reassign', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Message', exact: true })).toBeVisible()
      await expectNoPageOverflow(page)
      await attachConsole(page, testInfo, `${viewport.name}-light-context`)

      await page.getByRole('button', { name: 'Message', exact: true }).click()
      await expect(room).toHaveAttribute('aria-current', 'page')
      await expect(composer).toHaveValue('@Forge ')
      await composer.fill('Draft survives panels and theme changes.')
      await agents.click()
      await context.click()
      await room.click()
      await expect(composer).toHaveValue('Draft survives panels and theme changes.')
    } else {
      await expect(page.locator('.ac-sidebar')).toBeVisible()
      await expect(page.locator('.ac-main')).toBeVisible()
      await expect(page.locator('.ac-detail')).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Console panels' })).toBeHidden()
      await page.locator('.ac-agent-row').filter({ hasText: /Forge/i }).click()
      await page.getByRole('button', { name: 'Message', exact: true }).click()
      await composer.fill('Draft survives the desktop theme change.')
      if (viewport.width >= 2400) {
        expect(await page.locator('.ac-sidebar').evaluate((panel) => panel.getBoundingClientRect().width)).toBeGreaterThanOrEqual(340)
        expect(await page.locator('.ac-detail').evaluate((panel) => panel.getBoundingClientRect().width)).toBeGreaterThanOrEqual(515)
        expect(await page.locator('.ac-main').evaluate((panel) => panel.getBoundingClientRect().width)).toBeGreaterThan(2000)
      }
      await attachConsole(page, testInfo, `${viewport.name}-light-console`)
    }

    const beforeTheme = await mockServer.command('stats')
    const draft = await composer.inputValue()
    await theme.click()
    await expect(app).toHaveAttribute('data-theme', 'dark')
    await expect(theme).toHaveAttribute('aria-pressed', 'true')
    await expect(composer).toHaveValue(draft)
    const afterTheme = await mockServer.command('stats')
    expect(afterTheme).toMatchObject({
      eventRequests: beforeTheme.eventRequests,
      stateRequests: beforeTheme.stateRequests,
      activeStreams: beforeTheme.activeStreams,
    })
    await expectNoPageOverflow(page)
    if (mobile) {
      await page.getByRole('button', { name: 'Context', exact: true }).click()
      await expect(page.locator('.ac-agentpane-name')).toHaveText('Forge')
      await expectNoPageOverflow(page)
      await attachConsole(page, testInfo, `${viewport.name}-dark-context`)
      await page.getByRole('button', { name: 'Room', exact: true }).click()
      await expect(composer).toHaveValue(draft)
    } else {
      await expect(page.locator('.ac-agentpane-name')).toHaveText('Forge')
    }
    expect(await page.locator('.ac-app').evaluate((node) => getComputedStyle(node).colorScheme)).toContain('dark')
    expect(await page.locator('.ac-dot').first().evaluate((dot) => getComputedStyle(dot).animationName)).toBe('none')
    await attachConsole(page, testInfo, `${viewport.name}-dark-console`)
  })
}

test.describe('shared authenticated theme', () => {
  test.use({ authMode: 'session' })

  test('logged-in console starts light and shares its selected theme with the gate', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Operator key', { exact: true }).fill(OPERATOR_TOKEN)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()
    await expect(page.locator('.ac-session-shell')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('.ac-app')).toHaveAttribute('data-theme', 'light')

    await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
    await expect(page.locator('.ac-session-shell')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('.ac-app')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.getByLabel('Operator key', { exact: true })).toBeVisible()
    await expect(page.locator('.ac-auth-screen')).toHaveAttribute('data-theme', 'dark')
  })
})

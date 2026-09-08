import type { Locator, Page, TestInfo } from '@playwright/test'
import type { RunSnapshot, RunStatus } from '../../shared/protocol.js'
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

async function expectVisibleTokenDisclosure(
  page: Page,
  activation: 'keyboard' | 'touch' = 'keyboard',
  testInfo?: TestInfo,
  screenshotName?: string,
) {
  const disclosure = page.locator('.ac-token-disclosure')
  const summary = disclosure.locator('summary')
  if (activation === 'touch') await summary.tap()
  else {
    await summary.focus()
    await summary.press('Enter')
  }
  await expect(disclosure).toHaveAttribute('open', '')

  const popover = disclosure.locator('.ac-token-popover')
  await expect(popover).toBeVisible()
  await expect(popover.locator('dt')).toHaveText(['Input', 'Output', 'Cache read', 'Cache write'])
  const counters = await popover.locator('dd').allTextContents()
  expect(counters).toHaveLength(4)
  for (const counter of counters) expect(counter).toMatch(/^\d{1,3}(,\d{3})*$/)

  const inspection = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const clippedBy: string[] = []
    let ancestor = element.parentElement
    while (ancestor) {
      const style = getComputedStyle(ancestor)
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
        const boundary = ancestor.getBoundingClientRect()
        if (rect.left < boundary.left || rect.right > boundary.right || rect.top < boundary.top || rect.bottom > boundary.bottom) {
          clippedBy.push(ancestor.className || ancestor.tagName)
        }
      }
      ancestor = ancestor.parentElement
    }
    const occludedTargets = Array.from(element.querySelectorAll('dt, dd')).flatMap((target) => {
      const targetRect = target.getBoundingClientRect()
      const inset = Math.min(2, targetRect.width / 4)
      const y = targetRect.top + targetRect.height / 2
      return [targetRect.left + inset, targetRect.left + targetRect.width / 2, targetRect.right - inset]
        .flatMap((x) => {
          const topmost = document.elementFromPoint(x, y)
          const targetIsTopmost = topmost !== null
            && element.contains(topmost)
            && (topmost === target || target.contains(topmost) || topmost.contains(target))
          return targetIsTopmost ? [] : [{
            target: target.textContent?.trim() ?? target.tagName,
            topmost: topmost?.className || topmost?.tagName || null,
            x,
            y,
          }]
        })
    })
    return {
      clippedBy,
      insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      occludedTargets,
    }
  })
  if (testInfo && screenshotName) await attachConsole(page, testInfo, screenshotName)
  expect(inspection.clippedBy).toEqual([])
  expect(inspection.insideViewport).toBe(true)
  expect(inspection.occludedTargets).toEqual([])

  if (activation === 'touch') await summary.tap()
  else await summary.press('Enter')
  await expect(disclosure).not.toHaveAttribute('open', '')
}

async function contrastRatio(foreground: Locator, backgroundSelector: string, property: 'color' | 'outlineColor' = 'color') {
  return foreground.evaluate((element, { backgroundSelector, property }) => {
    type Rgba = [number, number, number, number]
    const parse = (value: string): Rgba => {
      const parts = value.match(/[\d.]+/g)?.map(Number) ?? []
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
    }
    const composite = (top: Rgba, bottom: Rgba): Rgba => {
      const alpha = top[3] + bottom[3] * (1 - top[3])
      if (alpha === 0) return [0, 0, 0, 0]
      return [
        (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
        (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
        (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
        alpha,
      ]
    }
    const resolvedBackground = (start: Element): Rgba => {
      const layers: Rgba[] = []
      let current: Element | null = start
      while (current) {
        layers.push(parse(getComputedStyle(current).backgroundColor))
        current = current.parentElement
      }
      return layers.reverse().reduce((result, layer) => composite(layer, result), [255, 255, 255, 1] as Rgba)
    }
    const background = document.querySelector(backgroundSelector)
    if (!background) throw new Error(`Missing contrast background ${backgroundSelector}`)
    const bg = resolvedBackground(background)
    const fg = composite(parse(getComputedStyle(element)[property]), bg)
    const luminance = (color: Rgba) => {
      const channel = (value: number) => {
        const normalized = value / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2])
    }
    const first = luminance(fg)
    const second = luminance(bg)
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
  }, { backgroundSelector, property })
}

async function useSyntheticRunState(page: Page, status: Extract<RunStatus, 'live' | 'paused' | 'failed'>) {
  const response = await page.request.get('/api/state')
  expect(response.ok()).toBeTruthy()
  const snapshot = await response.json() as RunSnapshot
  snapshot.run = {
    ...snapshot.run,
    status,
    error: status === 'failed' ? 'Synthetic review failure' : '',
  }
  snapshot.agents = snapshot.agents.map((agent) => agent.id === 'forge'
    ? { ...agent, status: status === 'failed' ? 'blocked' : 'working' }
    : agent)
  snapshot.typing = status === 'live' ? ['forge'] : []
  await page.addInitScript((initialSnapshot) => {
    class SyntheticEventSource extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSED = 2
      readonly url = '/api/events'
      readonly withCredentials = false
      readyState = SyntheticEventSource.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null

      constructor() {
        super()
        queueMicrotask(() => {
          this.readyState = SyntheticEventSource.OPEN
          this.onopen?.(new Event('open'))
          this.dispatchEvent(new MessageEvent('snapshot', {
            data: JSON.stringify({ type: 'snapshot', seq: initialSnapshot.seq, snapshot: initialSnapshot }),
          }))
        })
      }

      close() {
        this.readyState = SyntheticEventSource.CLOSED
      }
    }

    Object.defineProperty(window, 'EventSource', { configurable: true, value: SyntheticEventSource })
  }, snapshot)
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-320', width: 320, height: 720 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'tablet-1024', width: 1024, height: 768 },
  { name: 'ultrawide', width: 3440, height: 968 },
]) {
  test(`console remains usable in both themes at ${viewport.name}`, async ({ page, mockServer }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openConsole(page)

    const app = page.locator('.ac-app')
    const theme = page.getByRole('button', { name: 'Dark mode', exact: true })
    const composer = page.getByRole('textbox', { name: 'Message the room' })
    const mobile = viewport.width <= 1120

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
      if (viewport.width <= 390) {
        await expectVisibleTokenDisclosure(page, 'keyboard', testInfo, `${viewport.name}-light-tokens`)
      }
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
      if (viewport.width <= 390) {
        await expectVisibleTokenDisclosure(page, 'keyboard', testInfo, `${viewport.name}-dark-tokens`)
      }
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

test.describe('compact accessibility corrections', () => {
  test.use({ hasTouch: true })

  for (const viewport of [
    { name: 'phone-320', width: 320, height: 720 },
    { name: 'phone-390', width: 390, height: 844 },
  ]) {
    test(`token counters are topmost after touch disclosure at ${viewport.name} in both themes`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      await openConsole(page)
      await expectVisibleTokenDisclosure(page, 'touch', testInfo, `${viewport.name}-light-touch-tokens`)
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
      await expectVisibleTokenDisclosure(page, 'touch', testInfo, `${viewport.name}-dark-touch-tokens`)
    })
  }
})

test('compact keyboard transitions keep focus in the visible destination', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openConsole(page)

  const agentsNav = page.getByRole('button', { name: 'Agents', exact: true })
  await agentsNav.focus()
  await agentsNav.press('Enter')
  await expect(agentsNav).toBeFocused()

  const forge = page.locator('.ac-agent-row').filter({ hasText: /Forge/i })
  await forge.focus()
  await forge.press('Enter')
  const contextPanel = page.locator('.ac-detail')
  await expect(contextPanel).toBeVisible()
  await expect(contextPanel).toBeFocused()

  const message = page.getByRole('button', { name: 'Message', exact: true })
  await message.focus()
  await message.press('Enter')
  const composer = page.getByRole('textbox', { name: 'Message the room' })
  await expect(composer).toBeVisible()
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue('@Forge ')

  const contextNav = page.getByRole('button', { name: 'Context', exact: true })
  await contextNav.focus()
  await contextNav.press('Enter')
  await expect(contextNav).toBeFocused()
  await expect(contextPanel).toBeVisible()

  const close = page.locator('.ac-close')
  await close.focus()
  await close.press('Enter')
  const roomNav = page.getByRole('button', { name: 'Room', exact: true })
  await expect(roomNav).toBeFocused()
  await expect(composer).toBeVisible()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return false
    const rect = active.getBoundingClientRect()
    const style = getComputedStyle(active)
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
  })).toBe(true)
})

test('focus remains visible when a desktop panel becomes compact', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openConsole(page)
  const forge = page.locator('.ac-agent-row').filter({ hasText: /Forge/i })
  await forge.focus()
  await forge.press('Enter')
  await expect(forge).toBeFocused()

  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(forge).toBeVisible()
  await expect(forge).toBeFocused()
  await expectNoPageOverflow(page)
})

for (const controlName of ['Snapshot', 'Dark mode'] as const) {
  test(`${controlName} focus is not replaced by stale Context focus at the compact breakpoint`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openConsole(page)
    const interrupt = page.getByRole('button', { name: 'Interrupt', exact: true })
    await interrupt.focus()
    await expect(interrupt).toBeFocused()

    const persistentControl = page.getByRole('button', { name: controlName, exact: true })
    await persistentControl.focus()
    await expect(persistentControl).toBeFocused()
    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(persistentControl).toBeVisible()
    await expect(persistentControl).toBeFocused()
    await expectNoPageOverflow(page)
  })
}

for (const status of ['live', 'paused', 'failed'] as const) {
  test(`${status} status and focus indicators meet contrast targets in both themes`, async ({ page }, testInfo) => {
    const posts: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname)
    })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await useSyntheticRunState(page, status)
    await openConsole(page)
    const subtaskTab = page.getByRole('button', { name: 'Subtask', exact: true })
    const outputTab = page.getByRole('button', { name: 'Output log', exact: true })
    const footer = page.locator('.ac-log-foot')
    const activityText = page.locator('.ac-log-activity')
    await expect(page.getByRole('button', { name: 'Reassign', exact: true })).toBeDisabled()
    await expect(page.locator('.ac-control-reason--detail')).toBeVisible()

    const theme = page.getByRole('button', { name: 'Dark mode', exact: true })
    for (const mode of ['light', 'dark'] as const) {
      await expect(page.locator('.ac-app')).toHaveAttribute('data-theme', mode)
      await subtaskTab.click()
      const controlReasonContrast = await contrastRatio(page.locator('.ac-control-reason--detail'), '.ac-detail')
      expect(controlReasonContrast).toBeGreaterThanOrEqual(4.5)
      await outputTab.click()
      await expect(footer).toHaveAttribute('data-activity', status === 'live' ? 'active' : status)
      const statusContrast = await contrastRatio(activityText, '.ac-log')
      const runLabelContrast = await contrastRatio(page.locator('.ac-run-label'), '.ac-run-pill')
      expect(statusContrast).toBeGreaterThanOrEqual(4.5)
      expect(runLabelContrast).toBeGreaterThanOrEqual(4.5)
      await theme.focus()
      await expect(theme).toBeFocused()
      const focusContrast = await contrastRatio(theme, '.ac-header', 'outlineColor')
      expect(focusContrast).toBeGreaterThanOrEqual(3)
      await testInfo.attach(`${status}-${mode}-contrast.json`, {
        body: JSON.stringify({ controlReasonContrast, focusContrast, runLabelContrast, statusContrast }, null, 2),
        contentType: 'application/json',
      })
      await attachConsole(page, testInfo, `${status}-${mode}`)
      if (mode === 'light') await theme.click()
    }
    expect(posts).toEqual([])
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

  test('session-bar focus is not replaced by stale Context focus at the compact breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/')
    await page.getByLabel('Operator key', { exact: true }).fill(OPERATOR_TOKEN)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled()

    const interrupt = page.getByRole('button', { name: 'Interrupt', exact: true })
    await interrupt.focus()
    await expect(interrupt).toBeFocused()
    const signOut = page.getByRole('button', { name: 'Sign out', exact: true })
    await signOut.focus()
    await expect(signOut).toBeFocused()

    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(signOut).toBeVisible()
    await expect(signOut).toBeFocused()
    await expectNoPageOverflow(page)
  })
})

/// <reference lib="dom" />
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from './fixtures.js'

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'ultrawide', width: 3440, height: 968 },
]) {
  test(`standalone progress document renders and exposes every item at ${viewport.name}`, async ({ page }, testInfo) => {
    const data = JSON.parse(await readFile(resolve('project-progress/status.json'), 'utf8')) as {
      items: { id: string; status: string }[]
    }
    await page.setViewportSize(viewport)
    await page.goto(pathToFileURL(resolve('project-progress/index.html')).href)
    await expect(page.getByRole('heading', { name: 'From simulated runs to real delivery.' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Paginated work table' })).toBeVisible()
    for (const [link, completed] of [['Remaining work', false], ['Completed work', true]] as const) {
      await page.getByRole('link', { name: new RegExp(link) }).click()
      await expect(page.locator('caption')).toHaveText(link)
      const seen = new Set<string>()
      const next = page.getByRole('button', { name: 'Next →', exact: true })
      for (let n = 0; n <= data.items.length; n++) {
        const rows = page.locator('tbody tr[data-id]')
        await expect(rows.first()).toBeVisible()
        for (const id of await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute('data-id')!))) seen.add(id)
        if (await next.isDisabled()) break
        const previous = await page.getByRole('status').innerText()
        await next.click()
        await expect(page.getByRole('status')).not.toHaveText(previous)
      }
      expect([...seen].sort()).toEqual(data.items.filter((item) => (item.status === 'Complete') === completed).map((item) => item.id).sort())
    }
    await page.getByRole('link', { name: /Remaining work/ }).click()
    await expect(page.locator('caption')).toHaveText('Remaining work')
    await page.getByRole('searchbox', { name: 'Search' }).fill('No matching task 9876')
    await expect(page.getByText('No matching work items.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(page.locator('tbody tr').first()).toBeVisible()
    const theme = page.getByRole('button', { name: /mode/ })
    const before = await theme.getAttribute('aria-pressed')
    await theme.click()
    await expect(theme).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBeTruthy()
    await testInfo.attach(`progress-${viewport.name}`, { body: await page.screenshot({ fullPage: true, path: testInfo.outputPath(`progress-${viewport.name}.png`) }), contentType: 'image/png' })
    await page.emulateMedia({ media: 'print' })
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
    await expect(page.locator('tbody tr[data-id]')).toHaveCount(data.items.length)
  })
}

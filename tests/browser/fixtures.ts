import { fork } from 'node:child_process'
import { once } from 'node:events'
import { test as base, expect } from '@playwright/test'

interface MockServer { command(name: 'disconnect' | 'replay'): Promise<Record<string, unknown>> }

export const test = base.extend<{ mockServer: MockServer }>({
  mockServer: [async ({}, use, testInfo) => {
    // No inherited credentials, NODE_OPTIONS, provider settings or .env loader.
    const child = fork(new URL('./server.mjs', import.meta.url), [], {
      env: {}, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    child.stdout?.on('data', (data) => { output += String(data) })
    child.stderr?.on('data', (data) => { output += String(data) })
    let sequence = 0
    const waitMessage = (predicate: (value: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', failed) }
        const failed = (error: Error) => { cleanup(); reject(error) }
        const exited = () => failed(new Error(`Mock server exited: ${output}`))
        const message = (value: Record<string, unknown>) => { if (predicate(value)) { cleanup(); resolve(value) } }
        const timer = setTimeout(() => failed(new Error(`Mock server timed out: ${output}`)), 10_000)
        child.on('message', message); child.once('exit', exited); child.once('error', failed)
      })
    try {
      await waitMessage((value) => value.ready === true)
      await use({ command: async (command) => {
        const id = ++sequence
        const response = waitMessage((value) => value.id === id)
        child.send({ id, command })
        const result = await response
        if (result.error) throw new Error(String(result.error))
        return result
      } })
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('mock-server.log', { body: output, contentType: 'text/plain' })
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
        await exited.finally(() => clearTimeout(timer))
      }
    }
  }, { auto: true }],
})

export { expect }

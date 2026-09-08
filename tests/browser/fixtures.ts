import { fork, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, expect } from '@playwright/test'

export const OPERATOR_TOKEN = Buffer.alloc(32, 71).toString('base64url') // Synthetic fixture only.
interface MockServer { command(name: 'disconnect' | 'replay' | 'stats' | 'expire' | 'dispose'): Promise<Record<string, unknown>> }
type AuthMode = 'local' | 'session' | 'session-https'

export const test = base.extend<{ mockServer: MockServer; authMode: AuthMode }>({
  authMode: ['local', { option: true }],
  baseURL: async ({ authMode }, use) => use(`${authMode === 'session-https' ? 'https' : 'http'}://127.0.0.1:18787`),
  ignoreHTTPSErrors: async ({ authMode }, use) => use(authMode === 'session-https'),
  mockServer: [async ({ authMode }, use, testInfo) => {
    let tlsDir: string | undefined
    const args: string[] = [authMode]
    if (authMode === 'session-https') {
      tlsDir = await mkdtemp(join(tmpdir(), 'agent-chat-test-tls-'))
      const cert = join(tlsDir, 'cert.pem'), key = join(tlsDir, 'key.pem')
      try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' })
        args.push(cert, key)
      } catch (error) {
        await rm(tlsDir, { recursive: true, force: true }); throw error
      }
    }
    // No inherited credentials, NODE_OPTIONS, provider settings or .env loader.
    const child = fork(new URL('./server.mjs', import.meta.url), args, {
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
      if (tlsDir) await rm(tlsDir, { recursive: true, force: true })
    }
  }, { auto: true }],
})

export { expect }

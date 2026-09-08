import type { AuthStatusPayload } from '@shared/auth'

export type AuthLossReason = 'required' | 'signed_out'

const listeners = new Set<(reason: AuthLossReason) => void>()
let version = 0

export class AuthRequiredError extends Error {
  constructor() {
    super('Your session ended. Sign in to continue.')
    this.name = 'AuthRequiredError'
  }
}

/** A late response from an old session must never affect a newer sign-in. */
export function authVersion(): number {
  return version
}

export function ensureAuthVersion(expected: number): void {
  if (version !== expected) throw new AuthRequiredError()
}

export function notifyAuthLoss(reason: AuthLossReason = 'required', expected = version): void {
  if (expected !== version) return
  version += 1
  for (const listener of listeners) listener(reason)
}

export function subscribeAuthLoss(listener: (reason: AuthLossReason) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function isStatus(value: unknown): value is AuthStatusPayload {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<AuthStatusPayload>
  return (data.mode === 'local' || data.mode === 'session') &&
    typeof data.authenticated === 'boolean' &&
    (data.expiresAt === null || (typeof data.expiresAt === 'string' && Number.isFinite(Date.parse(data.expiresAt))))
}

async function authRequest(path: string, init: RequestInit, signal?: AbortSignal): Promise<AuthStatusPayload> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 10_000)
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
    if (response.status === 401) throw new AuthRequiredError()
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'))
      const delay = Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : 60
      throw new Error(`Too many sign-in attempts. Try again in ${delay} seconds.`)
    }
    if (response.status === 403) throw new Error('Open Agent Chatroom at its configured address, then try again.')
    if (!response.ok) throw new Error('Sign-in is unavailable right now. Try again shortly.')
    const data: unknown = await response.json()
    if (!isStatus(data)) throw new Error('The server returned an invalid sign-in status. Try again.')
    return data
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The server returned an invalid sign-in status. Try again.')
    if (error instanceof TypeError || controller.signal.aborted) {
      throw new Error('Cannot reach the run server. Check the connection and try again.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export function getAuthStatus(signal?: AbortSignal): Promise<AuthStatusPayload> {
  return authRequest('/api/auth/status', { method: 'GET' }, signal)
}

export async function login(key: string, signal?: AbortSignal): Promise<AuthStatusPayload> {
  try {
    return await authRequest('/api/auth/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    }, signal)
  } catch (error) {
    if (error instanceof AuthRequiredError) throw new Error('That operator key was not accepted. Try again.')
    throw error
  }
}

export function logout(signal?: AbortSignal): Promise<AuthStatusPayload> {
  return authRequest('/api/auth/logout', { method: 'POST' }, signal)
}

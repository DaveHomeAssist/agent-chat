import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AuthStatusPayload } from '@shared/auth'
import {
  AuthRequiredError,
  authVersion,
  getAuthStatus,
  login,
  logout,
  notifyAuthLoss,
  subscribeAuthLoss,
} from '../api/auth'
import type { AppTheme } from '../lib/theme'
import { ThemeControl } from './ThemeControl'

interface Props {
  children: ReactNode
  theme: AppTheme
  onToggleTheme: () => void
}

export function AuthGate({ children, theme, onToggleTheme }: Props) {
  const [status, setStatus] = useState<AuthStatusPayload | null>(null)
  const [phase, setPhase] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [logoutPending, setLogoutPending] = useState(false)
  const operation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const keyInput = useRef<HTMLInputElement>(null)
  const signOutButton = useRef<HTMLButtonElement>(null)

  const begin = useCallback(() => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const current = ++operation.current
    const expected = authVersion()
    return {
      signal: controller.signal,
      current: () => current === operation.current && !controller.signal.aborted && expected === authVersion(),
    }
  }, [])

  const checkStatus = useCallback(async () => {
    const attempt = begin()
    setPhase('checking')
    setError(null)
    try {
      const next = await getAuthStatus(attempt.signal)
      if (!attempt.current()) return
      setStatus(next)
      setPhase('ready')
    } catch (failure) {
      if (!attempt.current()) return
      setStatus(null)
      setPhase('unavailable')
      setError(failure instanceof AuthRequiredError
        ? 'Access could not be verified. Try again at the configured address.'
        : failure instanceof Error ? failure.message : 'Cannot verify access. Try again.')
    }
  }, [begin])

  useEffect(() => {
    const unsubscribe = subscribeAuthLoss((reason) => {
      operation.current += 1
      request.current?.abort()
      setStatus((previous) => previous ? { ...previous, authenticated: false, expiresAt: null } : null)
      setPhase('ready')
      setKey('')
      setBusy(null)
      setError(null)
      setNotice(reason === 'signed_out' ? 'Signing out…' : 'Your session ended. Sign in to continue.')
    })
    void checkStatus()
    return () => {
      operation.current += 1
      request.current?.abort()
      unsubscribe()
    }
  }, [checkStatus])

  useEffect(() => {
    if (!status?.authenticated || !status.expiresAt) return
    const expected = authVersion()
    const expiry = setTimeout(() => notifyAuthLoss('required', expected), Math.max(0, Date.parse(status.expiresAt) - Date.now()))
    return () => clearTimeout(expiry)
  }, [status])

  useEffect(() => {
    if (phase === 'ready' && status?.mode === 'session' && !status.authenticated && !busy && !logoutPending) {
      keyInput.current?.focus()
    } else if (phase === 'ready' && status?.mode === 'session' && status.authenticated) {
      signOutButton.current?.focus()
    }
  }, [phase, status, busy, logoutPending])

  const signIn = async (event: FormEvent) => {
    event.preventDefault()
    if (!key.trim() || busy || logoutPending) return
    const operatorKey = key.trim()
    setKey('')
    setError(null)
    setNotice(null)
    setBusy('login')
    const attempt = begin()
    try {
      const next = await login(operatorKey, attempt.signal)
      if (!attempt.current()) return
      if (!next.authenticated) throw new Error('Sign-in could not be completed. Try again.')
      setStatus(next)
    } catch (failure) {
      if (attempt.current()) setError(failure instanceof Error ? failure.message : 'Sign-in could not be completed. Try again.')
    } finally {
      if (attempt.current()) setBusy(null)
    }
  }

  const signOut = async () => {
    if (busy === 'logout') return
    // Clear the console and cancel old requests before waiting for the server.
    notifyAuthLoss('signed_out')
    setLogoutPending(true)
    setBusy('logout')
    const attempt = begin()
    try {
      const next = await logout(attempt.signal)
      if (!attempt.current()) return
      if (next.authenticated) throw new Error('The server could not confirm sign-out. Try again.')
      setStatus(next)
      setLogoutPending(false)
      setNotice('Signed out. Enter your operator key to return.')
    } catch (failure) {
      if (attempt.current()) {
        setNotice(null)
        setError(failure instanceof Error
          ? `Sign-out was not confirmed. ${failure.message}`
          : 'Sign-out was not confirmed. Try again.')
      }
    } finally {
      if (attempt.current()) setBusy(null)
    }
  }

  if (phase === 'ready' && status?.authenticated && (!status.expiresAt || Date.parse(status.expiresAt) > Date.now())) {
    if (status.mode === 'local') return <>{children}</>
    return (
      <div className="ac-session-shell" data-theme={theme}>
        <div className="ac-session-bar" aria-label="Operator session">
          <span><strong>Operator session</strong><span className="ac-session-expiry">{status.expiresAt ? ` · Ends ${new Date(status.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span></span>
          <button ref={signOutButton} type="button" onClick={() => { void signOut() }}>Sign out</button>
        </div>
        {children}
      </div>
    )
  }

  const canSignIn = phase === 'ready' && status?.mode === 'session' && !logoutPending
  return (
    <main className="ac-auth-screen" data-theme={theme}>
      <header className="ac-auth-topbar">
        <span className="ac-auth-brand">Agent Chatroom</span>
        <ThemeControl theme={theme} onToggle={onToggleTheme} />
      </header>
      <section className="ac-auth-panel" aria-labelledby="auth-title" aria-busy={phase === 'checking' || busy !== null}>
        <p className="ac-auth-eyebrow">Operator access</p>
        <h1 id="auth-title">{phase === 'checking' ? 'Checking access' : canSignIn ? 'Sign in to your console' : logoutPending ? 'Finish signing out' : 'Connect to your console'}</h1>
        <p className="ac-auth-description">{canSignIn
          ? 'Use your operator key to open the shared agent workspace.'
          : phase === 'checking' ? 'Waiting for the run server to verify this session.'
          : logoutPending ? 'The console is closed. Confirm sign-out with the server before continuing.'
          : 'Access must be verified before the workspace can open.'}</p>
        {notice && <p className="ac-auth-notice" role="status">{notice}</p>}
        {error && <p className="ac-auth-error" role="alert" id="auth-error">{error}</p>}
        {canSignIn && (
          <form onSubmit={(event) => { void signIn(event) }}>
            <label htmlFor="operator-key">Operator key</label>
            <input ref={keyInput} id="operator-key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128}
              value={key} onChange={(event) => setKey(event.target.value)} disabled={busy !== null}
              aria-invalid={error !== null} aria-describedby={error ? 'auth-error auth-key-note' : 'auth-key-note'} required />
            <p className="ac-auth-help" id="auth-key-note">The key is cleared after each attempt. This browser receives a temporary session cookie.</p>
            <button className="ac-auth-primary" type="submit" disabled={!key.trim() || busy !== null}>{busy === 'login' ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
        {logoutPending && <button className="ac-auth-primary" type="button" disabled={busy !== null} onClick={() => { void signOut() }}>{busy === 'logout' ? 'Signing out…' : 'Retry sign out'}</button>}
        {!canSignIn && !logoutPending && phase !== 'checking' && <button className="ac-auth-primary" type="button" onClick={() => { void checkStatus() }}>Retry connection</button>}
        <p className="ac-auth-footnote">{canSignIn ? 'One shared operator workspace. Sessions end on expiry or server restart.' : 'Run data stays hidden until access is confirmed.'}</p>
      </section>
      <footer className="ac-auth-footer">Shared workspace · Controlled access</footer>
    </main>
  )
}
